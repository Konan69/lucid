import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { attachRun } from './core.ts'
import { consume } from './fixtures/reading.ts'
import { runForPi } from './pi.ts'

const context = BACKGROUND_CONTEXT

/** Run the fixture until its tool is executing, then kill the process without any cleanup. */
const crashMidTool = Effect.fn('Test.crashMidTool')(function* (file: string) {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        process.execPath,
        [NodeURL.fileURLToPath(new URL('./fixtures/crash.ts', import.meta.url)), file],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      ),
    ),
    (spawned) =>
      Effect.sync(() => {
        spawned.kill('SIGKILL')
      }),
  )
  yield* Effect.callback<void, Error>((resume) => {
    const running = (line: Buffer) =>
      resume(
        Effect.sync(() => {
          expect(line.toString()).toContain('tool-running')
        }),
      )
    const failed = (error: Error) => resume(Effect.fail(error))
    child.stdout.once('data', running)
    child.once('error', failed)
    return Effect.sync(() => {
      child.stdout.removeListener('data', running)
      child.removeListener('error', failed)
    })
  })
  // Register the exit receipt before SIGKILL, and await this exact captured child's death.
  const exited = NodeEvents.EventEmitter.once(child, 'exit')
  child.kill('SIGKILL')
  yield* Effect.promise(() => exited)
})

it.live(
  'a client that attaches after a crash mid-tool gets the finished run',
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-'))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      )
      const file = NodePath.join(directory, 'session.sqlite')
      yield* crashMidTool(file)

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
              execute: (_args, _api, callbackContext) =>
                runForPi(
                  Effect.succeed({ content: [{ type: 'text' as const, text: '12 pages' }] }),
                  callbackContext.abortSignal,
                ),
            }),
          ],
        }),
      )
      const storage = yield* Effect.promise(() => openNodeSqliteStorage(file))
      const harness = yield* Effect.acquireRelease(
        Effect.promise(() => Harness.open(storage, { models, registry }, context)),
        (opened) => Effect.promise(() => opened.close(context)),
      )
      const root = yield* Effect.promise(() => harness.root(context))

      // Attach before the scheduler starts, so the stream holds the recovered state and then the rest.
      const attached = yield* attachRun(harness, root.id, context)
      const stream = Option.getOrThrow(attached)
      harness.resume()

      const { message } = yield* consume(stream, Option.none())

      expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
        toolCallId: 'call-1',
        state: 'output-available',
        output: { content: [{ type: 'text', text: '12 pages' }] },
      })
      expect(message.parts.at(-1)).toMatchObject({
        type: 'text',
        text: 'The report is ready.',
        state: 'done',
      })
      // The crash needs a second Node process; the timeout bounds startup and does not coordinate it.
    }),
  30_000,
)
