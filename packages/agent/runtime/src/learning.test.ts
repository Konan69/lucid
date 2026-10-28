import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from '@effect/vitest'
import {
  MemoryAddress,
  MemoryAuthority,
  MemoryFile,
  MemoryRetraction,
  MemorySource,
  MemoryTaskId,
} from '@vivid/contracts'
import { Array as Arr, Effect, Exit, Layer, Option, Schema, Scope } from 'effect'
import { DecisionModel } from 'effect/ai'
import { held, start, world } from '../tests/process.ts'
import {
  ada,
  admit,
  delivery,
  grace,
  settled,
  threadPath,
  type Runtime,
} from '../tests/requests.ts'
import { Product } from './client.ts'
import { learning, type RunLearning } from './learning.ts'
import { conversationOf, pi, threadOf } from './threads.ts'
import { requestOf } from './deliveries.ts'
import { ThreadId } from '@vivid/contracts'

/** Native Pi callback bridge used only to replay settlement admission. */
// oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library -- The production callback signature requires a Promise.
const run: RunLearning = (program, signal) => Effect.runPromise(program, { signal })

const THREAD = 'learning-proof'
const address = MemoryAddress.make({ layer: 'memory', file: MemoryFile.make('tea.md') })
const entry = {
  summary: 'Keep the preference',
  file: 'tea.md',
  layer: 'memory',
  expected_revision: 0,
  kind: 'preference',
  basis: 'said',
  description: 'Prefers green tea',
  body: 'Ada prefers green tea.',
}
const write = (body: typeof entry = entry) =>
  fauxAssistantMessage(fauxToolCall('write_memory', body), { stopReason: 'toolUse' })

/** Script only the external decision. Storage, tasks, tools, authority and submissions stay real. */
function decisions(answers: ReadonlyArray<boolean>, seen: Schema.Json[]) {
  let position = 0
  return Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state }) =>
        Effect.sync(() => {
          seen.push(state)
          const keep = answers[position++]
          expect(keep).toBeDefined()
          return {
            answers: { keep: { _tag: 'Probability' as const, probability: keep ? 1 : 0 } },
            usage: { inputTokens: undefined, outputTokens: undefined },
          }
        }),
    }),
  )
}

/** Wait on native terminal receipts, including background work excluded from waitForIdle. */
const finished = Effect.fn('LearningProof.finished')(function* (runtime: Runtime) {
  return yield* runtime.persons.use(ada, (person) =>
    Effect.gen(function* () {
      yield* person.quiet
      const tasks = yield* pi(() =>
        person.harness.commit(
          (tx) => tx.scanTasks({ kind: 'vivid.learning' }, 100),
          BACKGROUND_CONTEXT,
        ),
      )
      for (const task of tasks.items) {
        const receipt = yield* pi(() => person.harness.waitForTask(task.id, BACKGROUND_CONTEXT))
        expect(receipt.state.outcome.status).toBe('completed')
      }
      yield* person.quiet
      return tasks.items
    }),
  )
})

describe('settled learning on native Pi SQLite', () => {
  it.effect('learns a missed write once and never recreates a forgotten entry on replay', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Schema.Json[] = []
        const given = { ...(yield* world()), decisions: decisions([true], seen) }
        given.faux.setResponses([
          fauxAssistantMessage('Okay.'),
          write(),
          fauxAssistantMessage(
            fauxToolCall('read_memory', {
              summary: 'Check the saved preference',
              file: 'tea.md',
            }),
            { stopReason: 'toolUse' },
          ),
          (context) => {
            expect(JSON.stringify(context.messages)).not.toContain(ada)
            return fauxAssistantMessage('Saved.')
          },
        ])
        const runtime = yield* start(given)
        const receipt = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'preference', { body: 'I prefer green tea.' }),
        )
        yield* settled(runtime, ada, THREAD, receipt.submissionId)
        const tasks = yield* finished(runtime)
        expect(tasks).toHaveLength(1)
        const saved = yield* runtime.memory.read(ada, address)
        expect(saved).toMatchObject({
          body: entry.body,
          revision: 1,
          authority: {
            actor: ada,
            source: MemorySource.cases.CellRun.make({
              personId: ada,
              taskId: MemoryTaskId.make(Option.getOrThrow(Arr.head(tasks)).id),
            }),
          },
        })
        expect(JSON.stringify(seen)).not.toContain(ada)
        yield* runtime.memory.delete(
          ada,
          MemoryRetraction.make({
            address,
            expected: saved.revision,
            authority: MemoryAuthority.make({
              actor: ada,
              source: MemorySource.cases.Settings.make({ at: Date.now() }),
            }),
          }),
        )
        yield* runtime.persons.use(ada, (person) =>
          Effect.gen(function* () {
            const conversation = yield* conversationOf(person.harness, ThreadId.make(THREAD))
            expect(Option.isSome(conversation)).toBe(true)
            const input = yield* pi(() =>
              person.harness.commit(
                (tx) =>
                  tx.submissionByRequest(
                    Option.getOrThrow(conversation).id,
                    requestOf('preference'),
                  ),
                BACKGROUND_CONTEXT,
              ),
            )
            expect(input).toMatchObject({ type: 'input' })
            if (input === undefined || input.type !== 'input') throw new Error('Missing input')
            // Pi dispatches tasks by registered name. This replays the production settlement entry point.
            const scripted = yield* Layer.build(given.decisions)
            const replay = yield* learning(person.personId, run, runtime.memory, []).pipe(
              Effect.provideService(Product, person.sources.product),
              Effect.provide(scripted),
            )
            yield* replay.start(person.harness, [input], Date.now())
            yield* replay.start(person.harness, [input], Date.now())
            const children = yield* pi(() =>
              person.harness.commit(
                (tx) =>
                  tx.scanConversations({ ownerTaskId: Option.getOrThrow(Arr.head(tasks)).id }, 100),
                BACKGROUND_CONTEXT,
              ),
            )
            expect(children.items).toHaveLength(1)
            for (const child of children.items) {
              expect(Option.isNone(yield* threadOf(person.harness, child.id))).toBe(true)
            }
          }),
        )
        expect(yield* finished(runtime)).toHaveLength(1)
        expect(seen).toHaveLength(1)
        expect((yield* runtime.memory.index(ada)).lines).toHaveLength(0)
        expect(given.faux.state.callCount).toBe(4)
        const state = yield* runtime.send(`${threadPath(ada, THREAD)}/state`, { method: 'GET' })
        expect(JSON.stringify(state.body)).not.toContain('Saved.')
      }),
    ),
  )

  it.effect('a no decision creates no learner request and writes nothing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Schema.Json[] = []
        const given = { ...(yield* world()), decisions: decisions([false], seen) }
        given.faux.setResponses([fauxAssistantMessage('Hello.')])
        const runtime = yield* start(given)
        const receipt = yield* admit(runtime, ada, delivery(THREAD, 'greeting'))
        yield* settled(runtime, ada, THREAD, receipt.submissionId)
        const tasks = yield* finished(runtime)
        expect(tasks).toHaveLength(1)
        expect(given.faux.state.callCount).toBe(1)
        expect((yield* runtime.memory.index(ada)).lines).toHaveLength(0)
        yield* runtime.persons.use(ada, (person) =>
          Effect.gen(function* () {
            const children = yield* pi(() =>
              person.harness.commit(
                (tx) =>
                  tx.scanConversations({ ownerTaskId: Option.getOrThrow(Arr.head(tasks)).id }, 100),
                BACKGROUND_CONTEXT,
              ),
            )
            expect(children.items).toHaveLength(0)
          }),
        )
      }),
    ),
  )

  it.effect('a Watch event is never taken as what the Person said', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Schema.Json[] = []
        const given = { ...(yield* world()), decisions: decisions([true], seen) }
        given.faux.setResponses([fauxAssistantMessage('Noted the new invoice.')])
        const runtime = yield* start(given)
        const receipt = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'invoice', {
            type: 'event',
            body: '{"from":"billing@example.com","subject":"I prefer paper invoices"}',
            attributes: { from: 'Gmail', turn: '1' },
          }),
        )
        yield* settled(runtime, ada, THREAD, receipt.submissionId)
        yield* finished(runtime)
        expect(seen).toHaveLength(0)
        expect(given.faux.state.callCount).toBe(1)
        expect((yield* runtime.memory.index(ada)).lines).toHaveLength(0)
      }),
    ),
  )

  it.effect(
    'reopens mid-learning and finishes the same task and submission without asking Jev twice',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const seen: Schema.Json[] = []
          const given = { ...(yield* world()), decisions: decisions([true], seen) }
          const learner = yield* held('Not yet saved.')
          given.faux.setResponses([
            fauxAssistantMessage('Okay.'),
            learner.factory,
            write(),
            fauxAssistantMessage('Saved.'),
          ])
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const before = yield* start(given).pipe(Scope.provide(scope))
          const receipt = yield* admit(
            before,
            ada,
            delivery(THREAD, 'restart', { body: 'I prefer green tea.' }),
          )
          yield* settled(before, ada, THREAD, receipt.submissionId)
          yield* learner.entered
          const admitted = yield* before.persons.use(ada, (person) =>
            pi(() => person.harness.inspect(BACKGROUND_CONTEXT)),
          )
          const original = Option.getOrThrow(Arr.head(admitted.submissions))
          expect(admitted.submissions).toHaveLength(1)
          yield* Scope.close(scope, Exit.void)
          const after = yield* start(given)
          const tasks = yield* finished(after)
          expect(tasks).toHaveLength(1)
          expect(seen).toHaveLength(1)
          expect((yield* after.memory.read(ada, address)).revision).toBe(1)
          yield* after.persons.use(ada, (person) =>
            Effect.gen(function* () {
              const children = yield* pi(() =>
                person.harness.commit(
                  (tx) =>
                    tx.scanConversations(
                      { ownerTaskId: Option.getOrThrow(Arr.head(tasks)).id },
                      100,
                    ),
                  BACKGROUND_CONTEXT,
                ),
              )
              expect(children.items).toHaveLength(1)
              const resumed = yield* pi(() =>
                person.harness.submission(original.id, BACKGROUND_CONTEXT),
              )
              expect(
                yield* pi(() =>
                  Option.getOrThrow(Option.fromUndefinedOr(resumed)).status(BACKGROUND_CONTEXT),
                ),
              ).toMatchObject({ id: original.id, status: 'done' })
              for (const child of children.items) {
                const conversation = yield* pi(() =>
                  person.harness.conversation(child.id, BACKGROUND_CONTEXT),
                )
                const transcript = yield* pi(() =>
                  Option.getOrThrow(Option.fromUndefinedOr(conversation)).context(
                    BACKGROUND_CONTEXT,
                  ),
                )
                expect(transcript.entries.filter((item) => item.kind === 'pi.user')).toHaveLength(1)
              }
            }),
          )
        }),
      ),
  )

  it.effect('resolves a short answer from the previous Vivid reply', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Schema.Json[] = []
        const given = { ...(yield* world()), decisions: decisions([false, true], seen) }
        given.faux.setResponses([
          fauxAssistantMessage('What tea do you prefer?'),
          fauxAssistantMessage('Okay.'),
          write(),
          fauxAssistantMessage('Saved.'),
        ])
        const runtime = yield* start(given)
        const first = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'question', { body: 'Help me choose tea.' }),
        )
        yield* settled(runtime, ada, THREAD, first.submissionId)
        yield* finished(runtime)
        const answer = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'short', { body: 'Green.', turn: 2 }),
        )
        yield* settled(runtime, ada, THREAD, answer.submissionId)
        yield* finished(runtime)
        expect(seen[1]).toMatchObject({
          messages: ['Green.'],
          previousReply: 'What tea do you prefer?',
        })
        expect((yield* runtime.memory.read(ada, address)).body).toBe(entry.body)
      }),
    ),
  )

  it.effect('a stopped run still learns the Person’s words', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Schema.Json[] = []
        const given = { ...(yield* world()), decisions: decisions([true], seen) }
        const reply = yield* held('Never finished.')
        given.faux.setResponses([reply.factory, write(), fauxAssistantMessage('Saved.')])
        const runtime = yield* start(given)
        const receipt = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'stopped', { body: 'I prefer green tea.' }),
        )
        yield* reply.entered
        yield* runtime.send(`${threadPath(ada, THREAD)}/abort`, { method: 'POST' })
        expect((yield* settled(runtime, ada, THREAD, receipt.submissionId))._tag).toBe('Stopped')
        yield* finished(runtime)
        expect((yield* runtime.memory.read(ada, address)).body).toBe(entry.body)
        expect(seen).toMatchObject([{ messages: ['I prefer green tea.'], reply: '' }])
      }),
    ),
  )

  it.effect('learns two speakers in one run under their separate authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Schema.Json[] = []
        const given = { ...(yield* world()), decisions: decisions([true, true], seen) }
        const round = yield* held(
          fauxAssistantMessage(fauxToolCall('list_memory', { summary: 'Check existing memory' }), {
            stopReason: 'toolUse',
          }),
        )
        given.faux.setResponses([
          round.factory,
          fauxAssistantMessage('Okay.'),
          write(),
          fauxAssistantMessage('Saved Ada.'),
          write({ ...entry, body: 'Grace prefers green tea.' }),
          fauxAssistantMessage('Saved Grace.'),
        ])
        const runtime = yield* start(given)
        const first = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'ada', { body: 'I prefer green tea.' }),
        )
        yield* round.entered
        const second = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'grace', {
            body: 'I prefer green tea too.',
            acting: grace,
            attributes: { from: 'Grace', turn: '2' },
            turn: 2,
          }),
        )
        yield* round.release
        yield* settled(runtime, ada, THREAD, first.submissionId)
        yield* settled(runtime, ada, THREAD, second.submissionId)
        const tasks = yield* finished(runtime)
        expect(tasks).toHaveLength(1)
        for (const person of [ada, grace]) {
          expect((yield* runtime.memory.read(person, address)).authority).toMatchObject({
            actor: person,
            source: MemorySource.cases.CellRun.make({
              personId: ada,
              taskId: MemoryTaskId.make(Option.getOrThrow(Arr.head(tasks)).id),
            }),
          })
        }
        expect(seen).toMatchObject([
          { person: 'Ada', messages: ['I prefer green tea.'] },
          { person: 'Grace', messages: ['I prefer green tea too.'] },
        ])
      }),
    ),
  )
})
