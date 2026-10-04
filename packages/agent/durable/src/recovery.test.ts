import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { readUIMessageStream, type UIMessage } from 'ai'
import { expect, it } from 'vitest'

import { attachRun } from './stream.ts'

const context = BACKGROUND_CONTEXT

/** Run the fixture until its tool is executing, then kill the process without any cleanup. */
async function crashMidTool(file: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/crash.ts', import.meta.url)), file], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const [line] = (await once(child.stdout, 'data')) as [Buffer]
  expect(line.toString()).toContain('tool-running')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

it('a client that attaches after a crash mid-tool gets the finished run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-'))
  const file = join(directory, 'session.sqlite')
  try {
    await crashMidTool(file)

    // A new process: same storage, same tool name, a model that only has the final answer left.
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('The report is ready.')])
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: 'report',
        tools: [
          defineTool({
            name: 'report',
            description: 'Build the report',
            parameters: Type.Object({}),
            replay: 'safe',
            execute: async () => ({ content: [{ type: 'text', text: '12 pages' }] }),
          }),
        ],
      }),
    )
    const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context)
    const root = await harness.root(context)

    // Attach before the scheduler starts, so the stream holds the recovered state and then the rest.
    const stream = await attachRun(harness, root.id, context)
    expect(stream).toBeDefined()
    harness.resume()

    let message: UIMessage | undefined
    for await (const next of readUIMessageStream({ stream: stream! })) message = next

    expect(message?.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolCallId: 'call-1',
      state: 'output-available',
      output: { content: [{ type: 'text', text: '12 pages' }] },
    })
    expect(message?.parts.at(-1)).toMatchObject({ type: 'text', text: 'The report is ready.', state: 'done' })
    await harness.close(context)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
