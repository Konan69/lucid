import { Deferred, Effect, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
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
import { Schema } from 'effect'
import { tool } from 'ai'
import { z } from 'zod'
import { postgresFixture } from '../postgres/testing.ts'
import { streamRun, toolsExtension, abort, history, followRun } from '../main.ts'

const context = BACKGROUND_CONTEXT
const databaseUrl = process.env['VIVID_TEST_DATABASE_URL']
const backends =
  databaseUrl === undefined ? (['sqlite'] as const) : (['sqlite', 'postgres'] as const)
type Backend = (typeof backends)[number]
/** Repeat the same public Harness proofs against either real storage. Each test owns its
 * SQLite directory or PostgreSQL schema, and cleanup is registered before initialization writes. */
const storageFor = Effect.fn('Test.storageFor')(function* (backend: Backend) {
  if (backend === 'postgres') {
    if (databaseUrl === undefined) throw new Error('Expected disposable test database')
    const fixture = postgresFixture(databaseUrl)
    return {
      open: () => Effect.promise<Storage>(() => fixture.open()),
      child: ['postgres', fixture.schema],
    }
  }
  const directory = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'durable-identity-')),
  )
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  )
  const file = NodePath.join(directory, 'session.sqlite')
  const storages = new Set<Storage>()
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const storage of storages) yield* Effect.promise(() => storage.close(context))
    }),
  )
  return {
    child: ['sqlite', file],
    open: Effect.fn('Test.openIdentityStorage')(function* (): Effect.fn.Return<Storage> {
      const storage = yield* Effect.promise(() => openNodeSqliteStorage(file))
      storages.add(storage)
      return storage
    }),
  }
})
/** Native tools/hooks leave identity ownership with Pi; no bridge translator is under test yet. */
const opened = Effect.fn('Test.opened')(function* (
  storage: Storage,
  extensions: readonly Extension[],
) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  for (const extension of extensions) registry.install(extension)
  const harness = yield* Effect.promise(() => Harness.open(storage, { models, registry }, context))
  yield* Effect.addFinalizer(() => Effect.promise(() => harness.close(context)))
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  return { harness, root, faux }
})
/** The exact-frame document watch retains the FIRST task for each run even if later reads
 * observe handover. A receipt gate confirms delivery; no timer samples a mutable run. */
const starts = Effect.fn('Test.starts')(function* (harness: Harness, root: Conversation) {
  const watch = yield* Effect.promise(() => harness.watchDoc(LiveDoc, root.id, context))
  if (watch === undefined) throw new Error('Expected live document')
  yield* Effect.addFinalizer(() => Effect.promise(() => watch.stop().then(() => {})))
  const tasks = new Map<SubmissionId, TaskId>()
  const delivered = new Map<SubmissionId, Deferred.Deferred<void, FixtureFailed>>()
  watch.start(function recordLive(live) {
    if (live !== null && live.run !== undefined) {
      const input = live.run.inputs[0]
      if (input === undefined) throw new Error('Expected first run input')
      if (!tasks.has(input)) tasks.set(input, live.run.taskId)
      const receipt = delivered.get(input)
      if (receipt !== undefined) Deferred.doneUnsafe(receipt, Effect.void)
    }
    return Promise.resolve()
  })
  return {
    tasks,
    wait: Effect.fn('Test.waitForRunStart')(function* (input: SubmissionId) {
      if (tasks.has(input)) return
      const receipt = yield* Deferred.make<void, FixtureFailed>()
      delivered.set(input, receipt)
      yield* Deferred.await(receipt)
    }),
  }
})
/** Fork-aware entries are ordered independently of the document watcher and message translator. */
const assistants = Effect.fn('Test.assistants')(function* (root: Conversation) {
  return (yield* Effect.promise(() => root.entries({}, 100, undefined, context))).items
    .toReversed()
    .filter((entry) => entry.kind === 'pi.assistant')
})
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
const decodeTask = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThan(0)))
for (const backend of backends) {
  /** Idle admission appends the Person entry, receipt and generation on one serialized commit.
   * Concurrent conversations may interleave commits, never the identities within that commit. */
  it.live(
    `${backend}: idle receipts immediately precede generation tasks under concurrent admission`,
    () =>
      Effect.gen(function* () {
        const store = yield* storageFor(backend)
        const { harness, root, faux } = yield* opened(yield* store.open(), [])
        const other = yield* Effect.promise(() =>
          harness.createConversation(
            {
              ownership: { kind: 'ownerless' },
              agent: { model: { provider: 'faux', modelId: 'faux-1' } },
            },
            context,
          ),
        )
        const first = yield* starts(harness, root)
        const second = yield* starts(harness, other)
        faux.setResponses([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')])
        const admissions = yield* Effect.all(
          [
            Effect.promise(() =>
              root.submit({ type: 'input', content: 'First', requestId: 'first' }, context),
            ),
            Effect.promise(() =>
              other.submit({ type: 'input', content: 'Second', requestId: 'second' }, context),
            ),
          ],
          { concurrency: 'unbounded' },
        )
        const [one, two] = admissions
        if (one === undefined || two === undefined) throw new Error('Expected both admissions')
        yield* Effect.all([first.wait(one.id), second.wait(two.id)], { concurrency: 'unbounded' })
        expect(first.tasks.get(one.id)).toBe(one.id + 1)
        expect(second.tasks.get(two.id)).toBe(two.id + 1)
        yield* Effect.promise(() => harness.waitForIdle(context))
        expect(taskAt(yield* assistants(root), 0)).toBe(one.id + 1)
        expect(taskAt(yield* assistants(other), 0)).toBe(two.id + 1)
      }),
  )
  /** generation.abort commits an aborted outcome WITHOUT GenerationResult, although the
   * tools checkpoint and attributed assistant already exist. Closed-resume design must
   * account for this before replacing the current terminal correction contract. */
  it.live(`${backend}: an aborted first generation has an assistant entry but no result`, () =>
    Effect.gen(function* () {
      const store = yield* storageFor(backend)
      const extension = yield* Effect.promise(() =>
        toolsExtension(
          'approval',
          {
            pay: tool({
              inputSchema: z.object({}),
              execute: () => runForPi(Effect.succeed('paid'), undefined),
            }),
          },
          { approval: { pay: true } },
        ),
      )
      const { harness, root, faux } = yield* opened(yield* store.open(), [extension])
      const observed = yield* starts(harness, root)
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', {}, { id: 'pay' })], { stopReason: 'toolUse' }),
      ])
      const parked = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            harness,
            {
              conversationId: root.id,
              requestId: 'held',
              content: 'Pay',
            },
            context,
          ),
        ),
        Option.none(),
      )
      expect(parked.chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(true)
      const entries = yield* assistants(root)
      const first = taskAt(entries, 0)
      expect([...observed.tasks.values()]).toContain(first)
      const waiting = yield* Effect.promise(() => harness.getTask(first, context))
      if (waiting === undefined) throw new Error('Expected waiting generation')
      const assistant = entries[0]
      if (assistant === undefined) throw new Error('Expected calling assistant')
      expect(waiting.state.checkpoint).toMatchObject({ phase: 'tools', assistant: assistant.id })
      yield* Effect.promise(() => abort(harness, root.id, context))
      const task = yield* Effect.promise(() => harness.getTask(first, context))
      if (task === undefined || task.state.status !== 'terminal')
        throw new Error('Expected terminal generation')
      expect(task.state.outcome.status).toBe('aborted')
      expect(task.state.outcome).not.toHaveProperty('result')
      expect(task.state).not.toHaveProperty('checkpoint')
    }),
  )
  for (const mode of ['idle', 'queued', 'after-abort'] as const)
    it.live(`${backend}: first generation attribution for ${mode} admission`, () =>
      Effect.gen(function* () {
        const store = yield* storageFor(backend)
        const { harness, root, faux } = yield* opened(yield* store.open(), [])
        const observed = yield* starts(harness, root)
        const entered = yield* Deferred.make<void, FixtureFailed>()
        const release = yield* Deferred.make<void, FixtureFailed>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        faux.setResponses([
          mode === 'idle'
            ? fauxAssistantMessage('First.')
            : (_messages, options) =>
                runForPi(
                  Effect.gen(function* () {
                    Deferred.doneUnsafe(entered, Effect.void)
                    if (options === undefined || options.signal === undefined)
                      throw new Error('Expected provider abort signal')
                    const cancelled = () => Deferred.doneUnsafe(release, Effect.void)
                    options.signal.addEventListener('abort', cancelled, { once: true })
                    yield* Deferred.await(release)
                    options.signal.removeEventListener('abort', cancelled)
                    return fauxAssistantMessage('First.')
                  }),
                  undefined,
                ),
          fauxAssistantMessage('Successor.'),
        ])
        const first = yield* Effect.promise(() =>
          root.submit({ type: 'input', content: 'First', requestId: 'first' }, context),
        )
        yield* observed.wait(first.id)
        if (mode !== 'idle') yield* Deferred.await(entered)
        const next =
          mode === 'queued'
            ? yield* Effect.promise(() =>
                root.submit({ type: 'input', content: 'Next', requestId: 'next' }, context),
              )
            : first
        if (mode === 'after-abort') yield* Effect.promise(() => root.abort(context))
        Deferred.doneUnsafe(release, Effect.void)
        yield* Effect.promise(() => root.waitForIdle(context))
        if (mode === 'after-abort') {
          const successor = yield* Effect.promise(() =>
            root.submit({ type: 'input', content: 'After abort', requestId: 'after' }, context),
          )
          yield* observed.wait(successor.id)
          yield* Effect.promise(() => root.waitForIdle(context))
          expect(taskAt(yield* assistants(root), -1)).toBe(observed.tasks.get(successor.id))
        } else {
          yield* observed.wait(next.id)
          const entries = yield* assistants(root)
          expect(taskAt(entries, 0)).toBe(observed.tasks.get(first.id))
          expect(taskAt(entries, -1)).toBe(observed.tasks.get(next.id))
        }
      }),
    )
  for (const mode of ['tools', 'continuation'] as const)
    it.live(`${backend}: generation handover after ${mode} keeps distinct assistant tasks`, () =>
      Effect.gen(function* () {
        const store = yield* storageFor(backend)
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
        const { harness, root, faux } = yield* opened(yield* store.open(), [extension])
        const observed = yield* starts(harness, root)
        faux.setResponses([
          mode === 'tools'
            ? fauxAssistantMessage([fauxToolCall('work', {}, { id: 'work' })], {
                stopReason: 'toolUse',
              })
            : fauxAssistantMessage('First.'),
          fauxAssistantMessage('Final.'),
        ])
        const input = yield* Effect.promise(() =>
          root.submit({ type: 'input', content: 'Start', requestId: 'start' }, context),
        )
        yield* observed.wait(input.id)
        yield* Effect.promise(() => root.waitForIdle(context))
        const entries = yield* assistants(root)
        expect(entries).toHaveLength(2)
        const tasks = entries.map(taskOf)
        expect(tasks[0]).toBe(observed.tasks.get(input.id))
        expect(new Set(tasks).size).toBe(2)
      }),
    )
  it.live(
    `${backend}: fork preserves prefix generation ids and gives the child a distinct task`,
    () =>
      Effect.gen(function* () {
        const store = yield* storageFor(backend)
        const { harness, root, faux } = yield* opened(yield* store.open(), [])
        faux.setResponses([fauxAssistantMessage('Parent.'), fauxAssistantMessage('Child.')])
        yield* Effect.promise(() =>
          root.submit({ type: 'input', content: 'Parent', requestId: 'parent' }, context),
        )
        yield* Effect.promise(() => root.waitForIdle(context))
        const prefix = yield* assistants(root)
        const last = prefix.at(-1)
        if (last === undefined) throw new Error('Expected fork boundary')
        const child = yield* Effect.promise(() =>
          root.fork(last.id, { ownership: { kind: 'ownerless' } }, context),
        )
        const observed = yield* starts(harness, child)
        const input = yield* Effect.promise(() =>
          child.submit({ type: 'input', content: 'Child', requestId: 'child' }, context),
        )
        yield* observed.wait(input.id)
        yield* Effect.promise(() => child.waitForIdle(context))
        const entries = yield* assistants(child)
        expect(entries[0]).toEqual(prefix[0])
        expect(taskAt(entries, -1)).toBe(observed.tasks.get(input.id))
        expect(taskAt(entries, -1)).not.toBe(taskAt(prefix, 0))
        const parent = yield* Effect.promise(() =>
          history(harness, root.id, { limit: 10 }, context),
        )
        const saved = yield* Effect.promise(() =>
          history(harness, child.id, { limit: 10 }, context),
        )
        const parentAssistant = parent.messages.find((message) => message.role === 'assistant')
        const shared = saved.messages.find((message) => message.role === 'assistant')
        const own = saved.messages.findLast((message) => message.role === 'assistant')
        if (parentAssistant === undefined || shared === undefined || own === undefined)
          throw new Error('Expected forked assistant messages')
        expect(shared.id).toBe(parentAssistant.id)
        expect(own.id).not.toBe(shared.id)
        const followed = yield* consumeReadable(
          yield* Effect.promise(() => followRun(harness, child.id, 'child', context)),
          Option.none(),
        )
        expect(followed.message.id).toBe(own.id)
      }),
  )
  it.live(`${backend}: SIGKILL and retry of the first generation retain its task attribution`, () =>
    Effect.gen(function* () {
      const store = yield* storageFor(backend)
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL('./fixtures/generation.ts', import.meta.url)),
          ...store.child,
        ],
        { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }),
      )
      const exited = NodeEvents.EventEmitter.once(child, 'exit')
      const [message] = yield* Effect.promise(() =>
        Promise.race([
          NodeEvents.EventEmitter.once(child, 'message'),
          exited.then(() => {
            throw new Error('Generation child exited before its task receipt')
          }),
        ]),
      )
      // IPC supplies only the task id; the stored assistant entries independently validate it.
      const task = decodeTask(message)
      child.kill('SIGKILL')
      yield* Effect.promise(() => exited)
      const { harness, root, faux } = yield* opened(yield* store.open(), [])
      faux.setResponses([fauxAssistantMessage('Recovered.')])
      harness.resume()
      yield* Effect.promise(() => root.waitForIdle(context))
      const entries = yield* assistants(root)
      expect(entries.length).toBeGreaterThan(0)
      expect(taskAt(entries, 0)).toBe(task)
      expect(entries.map(taskOf)).toEqual(entries.map(() => task))
    }),
  )
}
