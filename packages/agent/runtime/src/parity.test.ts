import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import { createModels, Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, Harness } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import {
  CodeOutcome,
  ConversationFrame,
  ConversationState,
  RuntimeSettlement,
  ThreadId,
} from '@vivid/contracts'
import { ConfigProvider, Effect, Exit, Predicate, Schema, Scope } from 'effect'
import { databaseConfigured } from '../tests/database.ts'
import { held, start, world, type World } from '../tests/process.ts'
import {
  ada,
  admit,
  delivery,
  IDLE,
  scenario,
  settled,
  threadPath,
  type Runtime,
} from '../tests/requests.ts'
import { storesOn } from '../tests/stores.ts'
import { whole } from './state/link.ts'
import { ensureConversation } from './threads.ts'
import { codeOutcome } from './tools/code.ts'
import { toolResult } from './tools/tool.ts'
import { makeProviders } from './providers/models.ts'

const decodeState = Schema.decodeUnknownEffect(ConversationState)
const THREAD = 'thread-parity'
const path = threadPath(ada, THREAD)

/** Read the same persisted projection a newly opened screen receives. */
const read = Effect.fn('Parity.read')(function* (runtime: Runtime) {
  const response = yield* runtime.send(`${path}/state`, { method: 'GET' })
  expect(response.status).toBe(200)
  return yield* decodeState(response.body)
})

/** Apply wire operations exactly as a client does, retaining earlier replies between frames. */
const apply = (state: ConversationState, frame: ConversationFrame): ConversationState =>
  ConversationFrame.match(frame, {
    Whole: ({ state: next }) => next,
    Changes: ({ ops }) =>
      applyImmutable(
        state,
        ops.filter((op): op is Op => Array.isArray(op)),
      ),
  })

/** Only assistant prose counts as streamed words, rather than a status or metadata frame. */
const words = (state: ConversationState) =>
  state.messages
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : [],
    )
    .join('')

/** Observe actual RPC envelopes, including requests rejected by the unavailable test server. */
const requests = (given: World) =>
  given.requests
    .map((request) =>
      Predicate.isTagged(request.body, 'Uint8Array')
        ? new TextDecoder().decode(request.body.body)
        : '',
    )
    .join('\n')

describe.skipIf(!databaseConfigured)('main runtime parity on Pi', () => {
  it.effect('reopens the persisted SQLite note after runtime stop', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const given = yield* world()
        const note = {
          summary: 'Keep the preference',
          file: 'tea.md',
          kind: 'preference',
          description: 'Tea preference',
          note: 'Ada prefers green tea.',
        }
        given.faux.setResponses([
          fauxAssistantMessage(fauxToolCall('write_note', note), { stopReason: 'toolUse' }),
          fauxAssistantMessage('Remembered.'),
          fauxAssistantMessage(
            fauxToolCall('read_note', { summary: 'Read the preference', file: 'tea.md' }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Read it.'),
        ])
        const first = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(first, Exit.void))
        const before = yield* start(given, { idleMillis: IDLE }).pipe(Scope.provide(first))
        const written = yield* admit(before, ada, delivery(THREAD, 'write'))
        yield* settled(before, ada, THREAD, written.submissionId)
        expect((yield* read(before)).messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({
            toolName: 'write_note',
            output: { ok: true, file: 'tea.md', replaced: false },
          }),
        )
        yield* Scope.close(first, Exit.void)
        const after = yield* start(given, { idleMillis: IDLE })
        const opened = yield* admit(after, ada, delivery(THREAD, 'read', { turn: 2 }))
        yield* settled(after, ada, THREAD, opened.submissionId)
        expect((yield* read(after)).messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({
            toolName: 'read_note',
            output: { kind: 'preference', description: 'Tea preference', note: note.note },
          }),
        )
      }),
    ),
  )

  it.effect('an idle bodyless abort leaves a later submission free', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('next')])
        const first = yield* admit(runtime, ada, delivery(THREAD, 'first'))
        yield* settled(runtime, ada, THREAD, first.submissionId)
        expect(yield* runtime.send(`${path}/abort`, { method: 'POST' })).toEqual({
          status: 200,
          body: { aborted: false },
        })
        const next = yield* admit(runtime, ada, delivery(THREAD, 'next', { turn: 2 }))
        expect(yield* settled(runtime, ada, THREAD, next.submissionId)).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: next.submissionId,
            reply: 'next',
            toolCalls: 0,
          }),
        )
      }),
    ),
  )

  it.effect('settles both the held head and queued message when stopped', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const reply = yield* held('never completed')
        given.faux.setResponses([reply.factory])
        const first = yield* admit(runtime, ada, delivery(THREAD, 'head'))
        yield* reply.entered
        const queued = yield* admit(runtime, ada, delivery(THREAD, 'queued', { turn: 2 }))
        expect((yield* read(runtime)).queued).toBe(1)
        expect(yield* runtime.send(`${path}/abort`, { method: 'POST' })).toEqual({
          status: 200,
          body: { aborted: true },
        })
        for (const receipt of [first, queued])
          expect(yield* settled(runtime, ada, THREAD, receipt.submissionId)).toEqual(
            RuntimeSettlement.cases.Stopped.make({}),
          )
        expect(yield* read(runtime)).toMatchObject({ working: false, queued: 0 })
        expect(given.faux.state.callCount).toBe(1)
      }),
    ),
  )

  it.effect('rejects malformed turns before opening a Person or calling the model', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const valid = delivery(THREAD, 'valid')
        for (const body of [
          { ...valid, turn: 0 },
          { ...valid, scope: {} },
          { ...valid, attachments: 'bad' },
        ]) {
          expect(yield* runtime.send(path, { method: 'POST', body })).toEqual({
            status: 400,
            body: { error: 'InvalidRequest' },
          })
        }
        expect(given.faux.state.callCount).toBe(0)
        expect(given.requests).toHaveLength(0)
        given.faux.setResponses([fauxAssistantMessage('valid')])
        const receipt = yield* admit(runtime, ada, valid)
        expect(yield* settled(runtime, ada, THREAD, receipt.submissionId)).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: 'valid',
            toolCalls: 0,
          }),
        )
      }),
    ),
  )

  it.effect(
    'starting a conversation asks the Computer nothing until a Computer tool is called',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          given.faux.setResponses([
            fauxAssistantMessage('hello'),
            fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd' }), {
              stopReason: 'toolUse',
            }),
            fauxAssistantMessage('The Computer is unavailable.'),
          ])
          yield* read(runtime)
          expect(given.requests).toHaveLength(0)
          const first = yield* admit(runtime, ada, delivery(THREAD, 'greeting'))
          yield* settled(runtime, ada, THREAD, first.submissionId)
          expect(requests(given)).not.toMatch(/"tag":"Computer/)
          const next = yield* admit(runtime, ada, delivery(THREAD, 'computer', { turn: 2 }))
          yield* settled(runtime, ada, THREAD, next.submissionId)
          expect(requests(given)).toContain('ComputerShell')
        }),
      ),
  )

  it.effect('does not resend earlier tool payloads while a later reply settles', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall('suggest_replies', { replies: ['UNIQUE_OLD_TOOL_PAYLOAD'] }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('first reply'),
          fauxAssistantMessage('second reply'),
        ])
        const first = yield* admit(runtime, ada, delivery(THREAD, 'first'))
        yield* settled(runtime, ada, THREAD, first.submissionId)
        const link = yield* runtime.link(`${path}/state`)
        yield* Effect.addFinalizer(() => link.leave)
        const opening = yield* link.frame
        if (!ConversationFrame.guards.Whole(opening)) expect.fail('opening state')
        expect(JSON.stringify(opening)).toContain('UNIQUE_OLD_TOOL_PAYLOAD')
        const next = yield* admit(runtime, ada, delivery(THREAD, 'next', { turn: 2 }))
        let state = opening.state
        while (
          state.working ||
          !state.messages.some(
            (entry) =>
              entry.role === 'assistant' &&
              entry.submissionId === String(next.submissionId) &&
              entry.metadata !== undefined,
          )
        ) {
          const frame = yield* link.frame
          expect(JSON.stringify(frame)).not.toContain('UNIQUE_OLD_TOOL_PAYLOAD')
          state = apply(state, frame)
        }
        expect(words(state)).toBe('first replysecond reply')
        expect(state).toEqual(yield* read(runtime))
      }),
    ),
  )

  it.live('streams words at Pi cadence and preserves a cancelled partial across reopen', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const given = yield* world({ tokensPerSecond: 200 })
        const text = 'A long reply that must still be arriving when Stop is pressed. '.repeat(100)
        given.faux.setResponses([fauxAssistantMessage(text)])
        const first = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(first, Exit.void))
        const before = yield* start(given, { idleMillis: IDLE }).pipe(Scope.provide(first))
        const link = yield* before.link(`${path}/state`)
        const opening = yield* link.frame
        if (!ConversationFrame.guards.Whole(opening)) expect.fail('opening state')
        const receipt = yield* admit(before, ada, delivery(THREAD, 'partial'))
        let state = opening.state
        const received: number[] = []
        while (received.length < 4) {
          const frame = yield* link.frame
          const next = apply(state, frame)
          if (words(next).length > words(state).length) received.push(performance.now())
          state = next
        }
        // Three intervals distinguish the 100 ms default from the former one-second batching.
        const [firstAt] = received
        const lastAt = received.at(-1)
        expect(firstAt).toBeDefined()
        expect(lastAt).toBeDefined()
        if (firstAt === undefined || lastAt === undefined) expect.fail('four text frames')
        expect(lastAt - firstAt).toBeLessThan(750)
        expect(state.working).toBe(true)
        expect(words(state).length).toBeLessThan(text.length)
        expect(yield* before.send(`${path}/abort`, { method: 'POST' })).toMatchObject({
          body: { aborted: true },
        })
        expect(yield* settled(before, ada, THREAD, receipt.submissionId)).toEqual(
          RuntimeSettlement.cases.Stopped.make({}),
        )
        const stopped = yield* read(before)
        expect(words(stopped)).toBe(words(state))
        expect(stopped.settlements).toContainEqual(
          expect.objectContaining({
            submissionId: String(receipt.submissionId),
            outcome: 'aborted',
          }),
        )
        yield* link.leave
        yield* Scope.close(first, Exit.void)
        const after = yield* start(given, { idleMillis: IDLE })
        expect(words(yield* read(after))).toBe(words(stopped))
        expect(yield* settled(after, ada, THREAD, receipt.submissionId)).toEqual(
          RuntimeSettlement.cases.Stopped.make({}),
        )
      }),
    ),
  )

  it.effect('reconciles after a terminating tool without another model request', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const given = yield* world()
        const stores = yield* storesOn(given.database)
        const models = createModels()
        models.setProvider(given.faux.provider)
        const registry = createRegistry()
        // Exercise Vivid's production termination mapping against real Pi and PostgreSQL.
        registry.install(
          defineExtension({
            name: 'terminal',
            tools: [
              {
                name: 'blocked_program',
                description: 'A blocked program.',
                parameters: Type.Object({}),
                execute: () =>
                  Promise.resolve(
                    toolResult(
                      'blocked_program',
                      codeOutcome(CodeOutcome.cases.Blocked.make({ rule: 'blocked', calls: [] })),
                    ),
                  ),
              },
            ],
          }),
        )
        given.faux.setResponses([
          fauxAssistantMessage(
            [fauxText('The final reply.'), fauxToolCall('blocked_program', {})],
            { stopReason: 'toolUse' },
          ),
        ])
        const storage = yield* stores.open(ada)
        const harness = yield* Effect.acquireRelease(
          Effect.promise(() => Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT)),
          (value) => Effect.promise(() => value.close(BACKGROUND_CONTEXT)),
        )
        const conversation = yield* ensureConversation(harness, ThreadId.make(THREAD), {
          creator: ada,
          creatorName: 'Ada',
        })
        yield* Effect.promise(() =>
          conversation.configure(
            { model: { provider: 'fixture', modelId: 'text' } },
            BACKGROUND_CONTEXT,
          ),
        )
        const submission = yield* Effect.promise(() =>
          conversation.submit({ type: 'input', content: 'run it' }, BACKGROUND_CONTEXT),
        )
        yield* Effect.promise(() => submission.wait(BACKGROUND_CONTEXT))
        expect(given.faux.state.callCount).toBe(1)
        const state = yield* whole(harness, ThreadId.make(THREAD))
        expect(words(state)).toBe('The final reply.')
        expect(state.working).toBe(false)
        expect(yield* Effect.promise(() => submission.status(BACKGROUND_CONTEXT))).toMatchObject({
          status: 'done',
        })
        expect(state.messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({
            toolName: 'blocked_program',
            state: 'output-available',
            output: { ok: false, rule: 'blocked', calls: [] },
          }),
        )
      }),
    ),
  )

  it.effect('registers rehearsal only on explicit selection and executes its real tool', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configured = (values: Record<string, string>) =>
          makeProviders().pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown(values),
            ),
          )
        expect((yield* configured({})).models.getProvider('rehearsal')).toBeUndefined()
        const selected = yield* configured({ VIVID_MODEL: 'rehearsal/script' })
        expect(selected.modelName).toBe('rehearsal/script')
        expect(
          selected.models
            .getModels()
            .filter((model) => model.provider === 'rehearsal')
            .map((model) => model.id),
        ).toEqual(['script', 'paced'])
        const given = yield* world()
        const runtime = yield* start(
          {
            ...given,
            models: {
              collection: selected.models,
              selected: selected.model,
              name: selected.modelName,
              settings: selected.settings,
            },
          },
          { idleMillis: IDLE },
        )
        const receipt = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'rehearsal', { body: 'read example' }),
        )
        const outcome = yield* settled(runtime, ada, THREAD, receipt.submissionId)
        expect(RuntimeSettlement.guards.Done(outcome)).toBe(true)
        expect(outcome).toMatchObject({ toolCalls: 1 })
        expect(requests(given)).toContain('"tag":"ReadPage"')
        expect((yield* read(runtime)).messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({
            toolName: 'read_page',
            state: 'output-available',
            output: expect.objectContaining({ ok: false }),
          }),
        )
      }),
    ),
  )
})
