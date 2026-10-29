import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import {
  Computer,
  ComputerId,
  ComputerState,
  HandoffFieldResult,
  HandoffFormState,
  HandoffRequest,
  PrepareHandoffOutcome,
  PrepareHandoffRequest,
} from '@vivid/contracts'
import { HandoffClosed, HandoffNotAddressee, HandoffNotCleared } from '@vivid/contracts/rpc'
import { fixture, Observation, recordRuns, trustTestServices } from '../approvals/testing.ts'
import { ComputerStore } from '../computers/store.ts'
import type { HandoffEntry, HandoffPageBinding } from '../computers/machine.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { threads } from '../threads/tables.ts'
import {
  completeHandoff,
  fillHandoff,
  handoffsInThread,
  handoffsWaiting,
  prepareHandoff,
  withdrawHandoff,
} from './handoff.ts'
import { handoffs } from './tables.ts'

/** Values no row, signal, view or log line may ever hold. */
const EMAIL = `sentinel-email-${NodeCrypto.randomUUID()}@example.test`
const PASSWORD = `sentinel-password-${NodeCrypto.randomUUID()}`

const address = 'https://accounts.example.test/signin?session=private-token#step'
const page: HandoffPageBinding = { target: 'window-1', tab: 'tab-1', digest: 'digest-of-address' }

const signIn = PrepareHandoffRequest.cases.Form.make({
  kind: 'SignIn',
  summary: 'Sign in to Example so I can download your invoices.',
  fields: [
    { label: 'Email', purpose: 'Text' },
    { label: 'Password', purpose: 'Password' },
  ],
})

/**
 * The Computer as the handoff store reaches it: the page it shows and the browser's typing. It is
 * the provider seam, not the claim: these cases prove what the store keeps and tells, and record
 * only what reached the Computer, so the values are shown to arrive where they belong.
 */
/** A point in a Computer call the case holds open: it hears the call arrive and lets it go on. */
interface Gate {
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

/** Holds the call at `gate` when a case armed it; passes straight through otherwise. */
const pass = (gate: Ref.Ref<Option.Option<Gate>>) =>
  Effect.flatMap(
    Ref.getAndSet(gate, Option.none()),
    Option.match({
      onNone: () => Effect.void,
      onSome: (held) =>
        Deferred.succeed(held.entered, undefined).pipe(Effect.andThen(Deferred.await(held.release))),
    }),
  )

/** Arms a gate for the next call through it. */
const arm = Effect.fn('HandoffTest.arm')(function* (gate: Ref.Ref<Option.Option<Gate>>) {
  const held: Gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
  yield* Ref.set(gate, Option.some(held))
  return held
})

const recordingComputer = Effect.fn('HandoffTest.computer')(function* () {
  const typed = yield* Ref.make<ReadonlyArray<HandoffEntry>>([])
  /** What reached the Computer, in order: `typed` per fill and `cleared` per clearing. */
  const events = yield* Ref.make<ReadonlyArray<'typed' | 'cleared'>>([])
  const fillGate = yield* Ref.make(Option.none<Gate>())
  const clearGate = yield* Ref.make(Option.none<Gate>())
  const cleared = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
  /** The labels the next clearing cannot show empty; none by default. */
  const remaining = yield* Ref.make<ReadonlyArray<string>>([])
  const handedBack = yield* Ref.make(0)
  const record = Computer.make({
    id: ComputerId.make(NodeCrypto.randomUUID()),
    heldByPerson: false,
    state: ComputerState.cases.Absent.make({}),
  })
  const computer = Layer.mock(ComputerStore, {
    findFields: (_person, labels) =>
      Effect.succeed({ page, address, fields: labels.map(() => Option.none()) }),
    fillFields: (_person, _page, entries) =>
      pass(fillGate).pipe(
        Effect.andThen(Ref.update(typed, (before) => [...before, ...entries])),
        Effect.andThen(Ref.update(events, (before) => [...before, 'typed' as const])),
        Effect.as(entries.map(() => HandoffFieldResult.cases.Filled.make({}))),
      ),
    clearFields: (_person, _page, labels) =>
      pass(clearGate).pipe(
        Effect.andThen(Ref.update(cleared, (before) => [...before, labels])),
        Effect.andThen(Ref.update(events, (before) => [...before, 'cleared' as const])),
        Effect.andThen(Ref.get(remaining)),
      ),
    hold: () => Ref.update(handedBack, (count) => count + 1).pipe(Effect.as(record)),
  })
  return { layer: computer, typed, events, fillGate, clearGate, cleared, remaining, handedBack }
})

/** Every log line written while a case runs, as JSON with its annotations and spans. */
const capturedLogs = () => {
  const lines: Array<string> = []
  const capture = Logger.make((entry) => {
    lines.splice(lines.length, 0, JSON.stringify(Logger.formatJson.log(entry)))
  })
  return { layer: Logger.layer([capture], { mergeWithExisting: true }), lines }
}

const working = StoredRunOrigin.cases.Message.make({})

/** A sign-in Vivid prepared in the personal Thread and the Person asked has filled. */
const filledSignIn = Effect.fn('HandoffTest.filledSignIn')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
) {
  yield* recordRuns(test.personalId, [
    { id: 'acting', personId: test.personal.person.id, origin: working, working: true },
  ])
  const vivid = { ...test.personal, by: 'vivid' as const, threadId: Option.some(test.personalId) }
  const prepared = yield* prepareHandoff(vivid, signIn)
  if (!PrepareHandoffOutcome.guards.Prepared(prepared)) return expect.unreachable(prepared._tag)
  const handoff = prepared.handoff
  if (!HandoffRequest.guards.Form(handoff)) return expect.unreachable('a form')
  const [email, password] = handoff.fields
  if (password === undefined) return expect.unreachable('two fields')
  yield* fillHandoff(test.personal, {
    id: handoff.id,
    values: [
      { fieldId: email.id, value: Redacted.make(EMAIL) },
      { fieldId: password.id, value: Redacted.make(PASSWORD) },
    ],
  })
  return handoff
})

layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Handoffs', () => {
    it.effect(
      'H1 a filled sign-in reaches only the Computer, tells Vivid receipts, and continues once',
      () =>
        Effect.gen(function* () {
          const recorder = yield* recordingComputer()
          const logs = capturedLogs()
          const context = yield* Layer.build(
            Layer.mergeAll(trustTestServices, recorder.layer, logs.layer),
          )
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const person = test.personal.person
            yield* recordRuns(test.personalId, [
              { id: 'acting', personId: person.id, origin: working, working: true },
            ])
            const vivid = {
              ...test.personal,
              by: 'vivid' as const,
              threadId: Option.some(test.personalId),
            }
            const prepared = yield* prepareHandoff(vivid, signIn)
            if (!PrepareHandoffOutcome.guards.Prepared(prepared))
              return expect.unreachable(prepared._tag)
            const handoff = prepared.handoff
            if (!HandoffRequest.guards.Form(handoff)) return expect.unreachable('a form')
            // The page a Person reads has no query or fragment: those can hold a session.
            expect(handoff.page).toEqual({
              origin: 'https://accounts.example.test',
              address: 'https://accounts.example.test/signin',
            })
            expect(yield* handoffsWaiting(test.personal)).toEqual([handoff])
            const [email, password] = handoff.fields
            if (password === undefined) return expect.unreachable('two fields')
            const filled = yield* fillHandoff(test.personal, {
              id: handoff.id,
              values: [
                { fieldId: email.id, value: Redacted.make(EMAIL) },
                { fieldId: password.id, value: Redacted.make(PASSWORD) },
              ],
            })
            expect(filled.state).toEqual(
              HandoffFormState.cases.Ready.make({
                fields: [
                  { fieldId: email.id, result: HandoffFieldResult.cases.Filled.make({}) },
                  { fieldId: password.id, result: HandoffFieldResult.cases.Filled.make({}) },
                ],
              }),
            )
            // The values arrive where they belong, under the labels found on the page.
            expect(
              (yield* Ref.get(recorder.typed)).map((entry) => [
                entry.label,
                Redacted.value(entry.value),
              ]),
            ).toEqual([
              ['Email', EMAIL],
              ['Password', PASSWORD],
            ])
            const completed = yield* completeHandoff(test.personal, handoff.id)
            expect(completed.state._tag).toBe('Completed')
            const again = yield* completeHandoff(test.personal, handoff.id)
            expect(again).toEqual(completed)
            expect(yield* Ref.get(recorder.cleared)).toEqual([['Email', 'Password']])
            expect(yield* Ref.get(recorder.handedBack)).toBe(1)
            expect(yield* handoffsWaiting(test.personal)).toEqual([])
            // One continuation, as a Decision in the same Thread, however many finishes.
            const deliveries = yield* Ref.get((yield* Observation).deliveries)
            expect(deliveries.map((delivery) => delivery.idempotencyKey)).toEqual([
              `handoff-${handoff.id}`,
            ])
            const [delivery] = deliveries
            if (delivery === undefined) return expect.unreachable('one delivery')
            expect(delivery.threadId).toBe(test.personalId)
            expect(delivery.origin).toEqual(StoredRunOrigin.cases.Decision.make({}))
            const told = JSON.stringify(delivery.message)
            expect(told).toContain('Email: filled.')
            expect(told).toContain('Password: filled.')
            // Nothing that was typed is kept, told or logged, in any column, view or line.
            const database = yield* Database
            const stored = JSON.stringify(
              yield* database.run(
                database.select().from(handoffs).where(eq(handoffs.id, handoff.id)),
              ),
            )
            const shown = JSON.stringify(yield* handoffsInThread(test.personalId))
            const logged = logs.lines.join('\n')
            for (const value of [EMAIL, PASSWORD]) {
              expect(stored).not.toContain(value)
              expect(told).not.toContain(value)
              expect(shown).not.toContain(value)
              expect(logged).not.toContain(value)
            }
            expect(stored).not.toContain('private-token')
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )

    it.effect('H3 finishing waits until the Computer shows every field empty', () =>
      Effect.gen(function* () {
        const recorder = yield* recordingComputer()
        const context = yield* Layer.build(Layer.merge(trustTestServices, recorder.layer))
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const handoff = yield* filledSignIn(test)
          // The Computer could not show Password empty: the step stays open and the Computer held.
          yield* Ref.set(recorder.remaining, ['Password'])
          const refused = yield* Effect.result(completeHandoff(test.personal, handoff.id))
          if (Result.isSuccess(refused)) return expect.unreachable('a refusal')
          expect(refused.failure instanceof HandoffNotCleared).toBe(true)
          expect(refused.failure).toMatchObject({ id: handoff.id, labels: ['Password'] })
          expect((yield* handoffsWaiting(test.personal)).map((item) => item.id)).toEqual([
            handoff.id,
          ])
          expect(yield* Ref.get(recorder.handedBack)).toBe(0)
          expect(yield* Ref.get((yield* Observation).deliveries)).toEqual([])
          // Shown empty on the next try, the step finishes and Vivid carries on once.
          yield* Ref.set(recorder.remaining, [])
          const completed = yield* completeHandoff(test.personal, handoff.id)
          expect(completed.state._tag).toBe('Completed')
          expect(yield* Ref.get(recorder.handedBack)).toBe(1)
          expect(yield* Ref.get((yield* Observation).deliveries)).toHaveLength(1)
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('H4 no fill lands between a finish and the clearing that ends it', () =>
      Effect.gen(function* () {
        const recorder = yield* recordingComputer()
        const context = yield* Layer.build(Layer.merge(trustTestServices, recorder.layer))
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const handoff = yield* filledSignIn(test)
          const [, password] = handoff.fields
          if (password === undefined) return expect.unreachable('two fields')
          // The finish is clearing; the Person's second fill arrives in the middle of it.
          const clearing = yield* arm(recorder.clearGate)
          const finishing = yield* completeHandoff(test.personal, handoff.id).pipe(
            Effect.forkChild,
          )
          yield* Deferred.await(clearing.entered)
          const late = yield* Effect.result(
            fillHandoff(test.personal, {
              id: handoff.id,
              values: [{ fieldId: password.id, value: Redacted.make(PASSWORD) }],
            }),
          )
          expect(Result.isFailure(late) && late.failure instanceof HandoffClosed).toBe(true)
          yield* Deferred.succeed(clearing.release, undefined)
          const completed = yield* Fiber.join(finishing)
          expect(completed.state._tag).toBe('Completed')
          // Nothing was typed after the clearing that let the Computer go.
          expect(yield* Ref.get(recorder.events)).toEqual(['typed', 'cleared'])
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('H5 a withdrawal while a fill types waits for it, then clears what it typed', () =>
      Effect.gen(function* () {
        const recorder = yield* recordingComputer()
        const context = yield* Layer.build(Layer.merge(trustTestServices, recorder.layer))
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const handoff = yield* filledSignIn(test)
          const [, password] = handoff.fields
          if (password === undefined) return expect.unreachable('two fields')
          // A fill again is typing when the Person withdraws.
          const typing = yield* arm(recorder.fillGate)
          const filling = yield* fillHandoff(test.personal, {
            id: handoff.id,
            values: [{ fieldId: password.id, value: Redacted.make(PASSWORD) }],
          }).pipe(Effect.forkChild)
          yield* Deferred.await(typing.entered)
          const waiting = yield* withdrawHandoff(test.personal, handoff.id)
          // The withdrawal is claimed but nothing is cleared under a fill still typing.
          expect(waiting.state._tag).toBe('Applying')
          expect(yield* Ref.get(recorder.events)).toEqual(['typed'])
          expect(yield* Ref.get(recorder.handedBack)).toBe(0)
          yield* Deferred.succeed(typing.release, undefined)
          const ended = yield* Fiber.join(filling)
          expect(ended.state._tag).toBe('Withdrawn')
          expect(yield* Ref.get(recorder.events)).toEqual(['typed', 'typed', 'cleared'])
          expect(yield* Ref.get(recorder.handedBack)).toBe(1)
          expect(yield* handoffsWaiting(test.personal)).toEqual([])
          // A withdrawn step never wakes Vivid.
          expect(yield* Ref.get((yield* Observation).deliveries)).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )

    it.effect('H2 only the Person asked may fill a step in a Thread others can read', () =>
      Effect.gen(function* () {
        const recorder = yield* recordingComputer()
        const context = yield* Layer.build(Layer.merge(trustTestServices, recorder.layer))
        return yield* Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          yield* database.run(
            database
              .update(threads)
              .set({ audience: 'company' })
              .where(eq(threads.id, test.companyId)),
          )
          yield* recordRuns(test.companyId, [
            { id: 'acting', personId: test.member.person.id, origin: working, working: true },
          ])
          const vivid = {
            ...test.member,
            by: 'vivid' as const,
            threadId: Option.some(test.companyId),
          }
          const prepared = yield* prepareHandoff(vivid, signIn)
          if (!PrepareHandoffOutcome.guards.Prepared(prepared))
            return expect.unreachable(prepared._tag)
          const handoff = prepared.handoff
          if (!HandoffRequest.guards.Form(handoff)) return expect.unreachable('a form')
          // The owner can read the Thread and sees the step, but cannot type into it or finish it.
          expect((yield* handoffsInThread(test.companyId)).map((item) => item.id)).toEqual([
            handoff.id,
          ])
          const [email, password] = handoff.fields
          if (password === undefined) return expect.unreachable('two fields')
          const refused = yield* Effect.result(
            fillHandoff(test.owner, {
              id: handoff.id,
              values: [
                { fieldId: email.id, value: Redacted.make(EMAIL) },
                { fieldId: password.id, value: Redacted.make(PASSWORD) },
              ],
            }),
          )
          expect(Result.isFailure(refused) && refused.failure instanceof HandoffNotAddressee).toBe(
            true,
          )
          const finished = yield* Effect.result(completeHandoff(test.owner, handoff.id))
          expect(
            Result.isFailure(finished) && finished.failure instanceof HandoffNotAddressee,
          ).toBe(true)
          expect(yield* Ref.get(recorder.typed)).toEqual([])
          // A second step on the same Computer waits for this one.
          expect((yield* prepareHandoff(vivid, signIn))._tag).toBe('Busy')
        }).pipe(Effect.scoped, Effect.provide(context))
      }),
    )
  })
})
