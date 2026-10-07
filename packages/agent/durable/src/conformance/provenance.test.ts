import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  type Conversation,
  type EntryRecord,
  type Extension,
  type Storage,
  type SubmissionId,
  type TaskId,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { tool } from 'ai'
import { z } from 'zod'
import { onTestFinished } from 'vitest'
import { postgresFixture } from '../postgres/testing.ts'
import { streamRun, toolsExtension, abort } from '../main.ts'
import { consume, signal } from './fixtures/host.ts'

const context = BACKGROUND_CONTEXT
const databaseUrl = process.env['VIVID_TEST_DATABASE_URL']
const backends =
  databaseUrl === undefined ? (['sqlite'] as const) : (['sqlite', 'postgres'] as const)
type Backend = (typeof backends)[number]

/** Repeat the same public Harness proofs against either real storage. Each test owns its
 * SQLite directory or PostgreSQL schema, and cleanup is registered before initialization writes. */
async function storageFor(backend: Backend) {
  if (backend === 'postgres') {
    if (databaseUrl === undefined) throw new Error('Expected disposable test database')
    const fixture = postgresFixture(databaseUrl)
    return { open: fixture.open, child: ['postgres', fixture.schema] }
  }
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-identity-'))
  onTestFinished(() => NodeFSP.rm(directory, { recursive: true, force: true }))
  const file = NodePath.join(directory, 'session.sqlite')
  const storages = new Set<Storage>()
  onTestFinished(async () => {
    for (const storage of storages) await storage.close(context)
  })
  return {
    child: ['sqlite', file],
    open: async () => {
      const storage = await openNodeSqliteStorage(file)
      storages.add(storage)
      return storage
    },
  }
}

/** Native tools/hooks leave identity ownership with Pi; no bridge translator is under test yet. */
async function opened(storage: Storage, extensions: readonly Extension[]) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  for (const extension of extensions) registry.install(extension)
  const harness = await Harness.open(storage, { models, registry }, context)
  onTestFinished(() => harness.close(context))
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  return { harness, root, faux }
}

/** The exact-frame document watch retains the FIRST task for each run even if later reads
 * observe handover. A receipt gate confirms delivery; no timer samples a mutable run. */
async function starts(harness: Harness, root: Conversation) {
  const watch = await harness.watchDoc(LiveDoc, root.id, context)
  if (watch === undefined) throw new Error('Expected live document')
  onTestFinished(() => watch.stop().then(() => {}))
  const tasks = new Map<SubmissionId, TaskId>()
  const delivered = new Map<SubmissionId, ReturnType<typeof signal>>()
  watch.start(function recordLive(live) {
    if (live !== null && live.run !== undefined) {
      const input = live.run.inputs[0]
      if (input === undefined) throw new Error('Expected first run input')
      if (!tasks.has(input)) tasks.set(input, live.run.taskId)
      const receipt = delivered.get(input)
      if (receipt !== undefined) receipt.resolve()
    }
    return Promise.resolve()
  })
  return {
    tasks,
    wait: async (input: SubmissionId) => {
      if (tasks.has(input)) return
      const receipt = signal()
      delivered.set(input, receipt)
      await receipt.promise
    },
  }
}

/** Fork-aware entries are ordered independently of the document watcher and message translator. */
async function assistants(root: Conversation) {
  return (await root.entries({}, 100, undefined, context)).items
    .toReversed()
    .filter((entry) => entry.kind === 'pi.assistant')
}

/** An attributed assistant is required by the proposed gen:<task> contract, never guessed. */
function taskOf(entry: EntryRecord): TaskId {
  if (entry.byTaskId === undefined) throw new Error('Expected assistant task attribution')
  return entry.byTaskId
}

/** Array absence is an assertion failure; an entry's attribution is checked separately. */
function taskAt(entries: readonly EntryRecord[], index: number): TaskId {
  const entry = entries.at(index)
  if (entry === undefined) throw new Error('Expected assistant entry')
  return taskOf(entry)
}

const decodeTask = Schema.decodeUnknownSync(
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
)

for (const backend of backends) {
  /** generation.abort commits an aborted outcome WITHOUT GenerationResult, although the
   * tools checkpoint and attributed assistant already exist. Closed-resume design must
   * account for this before replacing the current terminal correction contract. */
  it.live(`${backend}: an aborted first generation has an assistant entry but no result`, () =>
    Effect.promise(async () => {
      const store = await storageFor(backend)
      const extension = await toolsExtension(
        'approval',
        {
          pay: tool({ inputSchema: z.object({}), execute: async () => 'paid' }),
        },
        { approval: { pay: true } },
      )
      const { harness, root, faux } = await opened(await store.open(), [extension])
      const observed = await starts(harness, root)
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', {}, { id: 'pay' })], { stopReason: 'toolUse' }),
      ])
      const parked = await consume(
        await streamRun(
          harness,
          {
            conversationId: root.id,
            requestId: 'held',
            content: 'Pay',
          },
          context,
        ),
      )
      expect(parked.chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true)
      const entries = await assistants(root)
      const first = taskAt(entries, 0)
      expect([...observed.tasks.values()]).toContain(first)
      const waiting = await harness.getTask(first, context)
      if (waiting === undefined) throw new Error('Expected waiting generation')
      const assistant = entries[0]
      if (assistant === undefined) throw new Error('Expected calling assistant')
      expect(waiting.state.checkpoint).toMatchObject({ phase: 'tools', assistant: assistant.id })
      await abort(harness, root.id, context)
      const task = await harness.getTask(first, context)
      if (task === undefined || task.state.status !== 'terminal')
        throw new Error('Expected terminal generation')
      expect(task.state.outcome.status).toBe('aborted')
      expect(task.state.outcome).not.toHaveProperty('result')
      expect(task.state).not.toHaveProperty('checkpoint')
    }),
  )
  for (const mode of ['idle', 'queued', 'after-abort'] as const)
    it.live(`${backend}: first generation attribution for ${mode} admission`, () =>
      Effect.promise(async () => {
        const store = await storageFor(backend)
        const { harness, root, faux } = await opened(await store.open(), [])
        const observed = await starts(harness, root)
        const entered = signal()
        const release = signal()
        onTestFinished(() => release.resolve())
        faux.setResponses([
          mode === 'idle'
            ? fauxAssistantMessage('First.')
            : async (_messages, options) => {
                entered.resolve()
                if (options === undefined || options.signal === undefined)
                  throw new Error('Expected provider abort signal')
                const cancelled = () => release.resolve()
                options.signal.addEventListener('abort', cancelled, { once: true })
                await release.promise
                options.signal.removeEventListener('abort', cancelled)
                return fauxAssistantMessage('First.')
              },
          fauxAssistantMessage('Successor.'),
        ])
        const first = await root.submit(
          { type: 'input', content: 'First', requestId: 'first' },
          context,
        )
        await observed.wait(first.id)
        if (mode !== 'idle') await entered.promise
        const next =
          mode === 'queued'
            ? await root.submit({ type: 'input', content: 'Next', requestId: 'next' }, context)
            : first
        if (mode === 'after-abort') await root.abort(context)
        release.resolve()
        await root.waitForIdle(context)
        if (mode === 'after-abort') {
          const successor = await root.submit(
            { type: 'input', content: 'After abort', requestId: 'after' },
            context,
          )
          await observed.wait(successor.id)
          await root.waitForIdle(context)
          expect(taskAt(await assistants(root), -1)).toBe(observed.tasks.get(successor.id))
        } else {
          await observed.wait(next.id)
          const entries = await assistants(root)
          expect(taskAt(entries, 0)).toBe(observed.tasks.get(first.id))
          expect(taskAt(entries, -1)).toBe(observed.tasks.get(next.id))
        }
      }),
    )

  for (const mode of ['tools', 'continuation'] as const)
    it.live(`${backend}: generation handover after ${mode} keeps distinct assistant tasks`, () =>
      Effect.promise(async () => {
        const store = await storageFor(backend)
        const extension = defineExtension({
          name: 'identity',
          tools: [
            defineTool({
              name: 'work',
              description: 'Identity proof',
              parameters: Type.Object({}),
              execute: () =>
                Promise.resolve({ content: [{ type: 'text' as const, text: 'Worked.' }] }),
            }),
          ],
          hooks: [
            hook(GenerationTask, {
              onYield: (message) =>
                mode === 'continuation' &&
                message.content.some((part) => part.type === 'text' && part.text === 'First.')
                  ? { continue: 'Continue' }
                  : undefined,
            }),
          ],
        })
        const { harness, root, faux } = await opened(await store.open(), [extension])
        const observed = await starts(harness, root)
        faux.setResponses([
          mode === 'tools'
            ? fauxAssistantMessage([fauxToolCall('work', {}, { id: 'work' })], {
                stopReason: 'toolUse',
              })
            : fauxAssistantMessage('First.'),
          fauxAssistantMessage('Final.'),
        ])
        const input = await root.submit(
          { type: 'input', content: 'Start', requestId: 'start' },
          context,
        )
        await observed.wait(input.id)
        await root.waitForIdle(context)
        const entries = await assistants(root)
        expect(entries).toHaveLength(2)
        const tasks = entries.map(taskOf)
        expect(tasks[0]).toBe(observed.tasks.get(input.id))
        expect(new Set(tasks).size).toBe(2)
      }),
    )

  it.live(
    `${backend}: fork preserves prefix generation ids and gives the child a distinct task`,
    () =>
      Effect.promise(async () => {
        const store = await storageFor(backend)
        const { harness, root, faux } = await opened(await store.open(), [])
        faux.setResponses([fauxAssistantMessage('Parent.'), fauxAssistantMessage('Child.')])
        await root.submit({ type: 'input', content: 'Parent', requestId: 'parent' }, context)
        await root.waitForIdle(context)
        const prefix = await assistants(root)
        const last = prefix.at(-1)
        if (last === undefined) throw new Error('Expected fork boundary')
        const child = await root.fork(last.id, { ownership: { kind: 'ownerless' } }, context)
        const observed = await starts(harness, child)
        const input = await child.submit(
          { type: 'input', content: 'Child', requestId: 'child' },
          context,
        )
        await observed.wait(input.id)
        await child.waitForIdle(context)
        const entries = await assistants(child)
        expect(entries[0]).toEqual(prefix[0])
        expect(taskAt(entries, -1)).toBe(observed.tasks.get(input.id))
        expect(taskAt(entries, -1)).not.toBe(taskAt(prefix, 0))
      }),
  )

  it.live(`${backend}: SIGKILL and retry of the first generation retain its task attribution`, () =>
    Effect.promise(async () => {
      const store = await storageFor(backend)
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL('./fixtures/generation.ts', import.meta.url)),
          ...store.child,
        ],
        { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
      )
      onTestFinished(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      })
      const exited = NodeEvents.EventEmitter.once(child, 'exit')
      const [message] = await Promise.race([
        NodeEvents.EventEmitter.once(child, 'message'),
        exited.then(() => {
          throw new Error('Generation child exited before its task receipt')
        }),
      ])
      // IPC supplies only the task id; the stored assistant entries independently validate it.
      const task = decodeTask(message)
      child.kill('SIGKILL')
      await exited
      const { harness, root, faux } = await opened(await store.open(), [])
      faux.setResponses([fauxAssistantMessage('Recovered.')])
      harness.resume()
      await root.waitForIdle(context)
      const entries = await assistants(root)
      expect(entries.length).toBeGreaterThan(0)
      expect(taskAt(entries, 0)).toBe(task)
      expect(entries.map(taskOf)).toEqual(entries.map(() => task))
    }),
  )
}
