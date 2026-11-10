import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Clock, Effect, Option, Ref, Result, Schema } from 'effect'
import {
  ApprovalId,
  ApprovalInvalidation,
  ProposedAction,
  IntegrationPause,
  IntegrationRequestId,
  ActionReceipt,
  ActionTarget,
  ServiceId,
  ActionReconciliation,
  ActionReconciliationRequired,
  RunId,
  ToolCallId,
  ToolOutcome,
  type ConnectionId,
} from '@vivid/contracts'
import * as TestClock from 'effect/testing/TestClock'
import type { Actor } from '../auth/access.ts'
import { ExecutorCallOutcome } from '../connections/executor.ts'
import { ConnectionStore } from '../connections/store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from '../connections/testing.ts'
import { useTool } from '../connections/tools.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  ActionLookup,
  Claim,
  Lookup,
  answerBefore,
  claim,
  operationOf,
  reconcile,
  settle,
  unresolvedOf,
} from './journal.ts'
import { approvals } from '../approvals/tables.ts'
import { prepareReconciliation } from '../connections/reconcile.ts'
import { connections } from '../connections/tables.ts'
import { actions } from './tables.ts'
import { invalidatePending } from '../approvals/stale.ts'

/** A Vivid write in the fixture's Thread through one private Integration the owner made. */
const writer = Effect.fn('Actions.test.writer')(function* () {
  const { ownerActor, threadId } = yield* fixture()
  const step = yield* (yield* ConnectionStore).begin(ownerActor, {
    from: 'Web',
    service: serviceId,
    name: 'Records',
    shared: false,
  })
  const actor: Actor = { ...ownerActor, by: 'vivid', threadId: Option.some(threadId) }
  const write = (input: { readonly record: number }) => ({
    toolCallId: ToolCallId.make(crypto.randomUUID()),
    connectionId: step.connection.id satisfies ConnectionId,
    tool: 'write',
    input,
    summary: 'Write the record',
    rationale: 'The Person asked for it',
  })
  return { actor, owner: ownerActor.person.id, threadId, write }
})

/** A provider lookup that answers for the test; the journal's rules around it are production. */
const lookingUp = (answer: Lookup) => ActionLookup.of({ look: () => Effect.succeed(answer) })

describe.skipIf(!testDatabaseConfigured)('Action journal', () => {
  layer(connectionTestLayer)((it) => {
    it.effect('a call held by a waiting Integration ask is not unheard until the ask settles', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const { owner, threadId, write } = yield* writer()
        const runId = RunId.make(crypto.randomUUID())
        const id = operationOf.program()
        const target = ActionTarget.cases.Connection.make({
          connectionId: write({ record: 3 }).connectionId,
          account: 'Records',
          tool: 'write',
          input: { record: 3 },
        })
        expect(
          Claim.guards.Fresh(
            yield* claim({ personId: owner, id, threadId, runId, approvalId: null, target }),
          ),
        ).toBe(true)
        // Claimed and never answered: the Run says it did not hear back.
        expect((yield* unresolvedOf([runId])).get(runId)).toMatchObject({ operationId: id })
        const approvalId = crypto.randomUUID()
        yield* database.run(
          database.insert(approvals).values({
            id: approvalId,
            threadId,
            personId: owner,
            action: { continuation: { operation: id } },
            digest: 'held',
            status: 'pending',
            expiresAt: Date.now() + 60_000,
            createdAt: Date.now(),
          }),
        )
        // The Integration paused the call and its Approval waits on the Person: not unheard.
        expect((yield* unresolvedOf([runId])).has(runId)).toBe(false)
        yield* TestClock.adjust('10 minutes')
        const held = yield* reconcile(owner, id).pipe(
          Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Absent.make({}))),
        )
        expect(held.reconciliation._tag).toBe('Inconclusive')
        yield* database.run(
          database.update(approvals).set({ status: 'expired' }).where(eq(approvals.id, approvalId)),
        )
        // Once the ask is settled, what the journal holds for the call applies again.
        expect((yield* unresolvedOf([runId])).get(runId)).toMatchObject({ operationId: id })
      }).pipe(Effect.scoped),
    )

    it.effect(
      'absence holds a timed-out or dispatching attempt until its landing window closes',
      () =>
        Effect.gen(function* () {
          const database = yield* Database
          for (const dispatching of [false, true]) {
            const { owner, threadId, write } = yield* writer()
            const target = ActionTarget.cases.Connection.make({
              connectionId: write({ record: 10 }).connectionId,
              account: 'Calendar',
              tool: 'calendarApi.calendarEventsInsert',
              input: {},
            })
            const original = {
              personId: owner,
              id: operationOf.program(),
              threadId,
              runId: null,
              approvalId: null,
              target,
            }
            yield* claim(original)
            const claimedAt = yield* Clock.currentTimeMillis
            if (!dispatching)
              yield* settle(
                ActionReceipt.cases.Unknown.make({
                  operationId: original.id,
                  observedAt: claimedAt,
                }),
              )
            const lookup = lookingUp(Lookup.cases.Absent.make({}))
            yield* TestClock.adjust(599_999)
            const early = yield* reconcile(owner, original.id).pipe(
              Effect.provideService(ActionLookup, lookup),
            )
            expect(early.reconciliation._tag).toBe('Inconclusive')
            const [stored] = yield* database.run(
              database
                .select({ reconciliation: actions.reconciliation })
                .from(actions)
                .where(eq(actions.id, original.id)),
            )
            expect(stored?.reconciliation).toMatchObject({
              decidableAt: claimedAt + 600_000,
            })
            const retry = { ...original, id: operationOf.program() }
            expect(
              yield* claim(retry).pipe(Effect.provideService(ActionLookup, lookup), Effect.flip),
            ).toEqual(new ActionReconciliationRequired({ operationId: original.id }))
            yield* TestClock.adjust(1)
            expect(
              Claim.guards.Fresh(
                yield* claim(retry).pipe(Effect.provideService(ActionLookup, lookup)),
              ),
            ).toBe(true)
          }
        }).pipe(Effect.scoped),
    )

    it.effect(
      'invalidating a held pause settles its journal so reconciliation permits a fresh attempt',
      () =>
        Effect.gen(function* () {
          const database = yield* Database
          const { owner, threadId, write } = yield* writer()
          const now = yield* Clock.currentTimeMillis
          const target = ActionTarget.cases.Connection.make({
            connectionId: write({ record: 11 }).connectionId,
            account: 'Calendar',
            tool: 'calendarApi.calendarEventsInsert',
            input: {},
          })
          const original = {
            personId: owner,
            id: operationOf.program(),
            threadId,
            runId: null,
            approvalId: null,
            target,
          }
          yield* claim(original)
          const id = ApprovalId.make(crypto.randomUUID())
          const pause = IntegrationPause.cases.Approval.make({
            requestId: IntegrationRequestId.make('held'),
            expiresAt: now + 600_000,
            form: {
              mode: 'form',
              message: 'Allow?',
              requestedSchema: { type: 'object', properties: {} },
            },
            savedCall: {
              app: 'calendar',
              owner: 'person',
              version: 'v1',
              tool: target.tool,
              input: {},
              accounts: { app: {} },
            },
          })
          const action = ProposedAction.make({
            summary: 'Create event',
            rationale: 'Asked',
            effect: 'write',
            target,
            continuation: { pause, operation: original.id },
          })
          yield* database.run(
            database.insert(approvals).values({
              id,
              threadId,
              personId: owner,
              action: Schema.encodeSync(ProposedAction)(action),
              digest: 'held',
              status: 'pending',
              expiresAt: pause.expiresAt,
              createdAt: now,
            }),
          )
          yield* TestClock.adjust('10 minutes')
          yield* database.transaction((tx) =>
            invalidatePending(
              tx,
              eq(approvals.id, id),
              ApprovalInvalidation.cases.RunStopped.make({ runId: RunId.make('stopped') }),
            ),
          )
          const [stored] = yield* database.run(
            database
              .select({ receipt: actions.receipt })
              .from(actions)
              .where(eq(actions.id, original.id)),
          )
          expect(stored?.receipt).toEqual(
            ActionReceipt.cases.Unknown.make({
              operationId: original.id,
              observedAt: now + 600_000,
            }),
          )
          const retry = yield* claim({ ...original, id: operationOf.program() }).pipe(
            Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Absent.make({}))),
          )
          expect(Claim.guards.Fresh(retry)).toBe(true)
        }).pipe(Effect.scoped),
    )

    it.effect('answers a retried call with its first receipt and sends it once', () =>
      Effect.gen(function* () {
        const { actor, write } = yield* writer()
        const probe = yield* ConnectionProbe
        const sent = yield* Ref.get(probe.calls)
        const request = write({ record: 1 })
        const { outcome: first } = yield* useTool(actor, request)
        if (!ToolOutcome.guards.Completed(first) || first.receipt === null)
          return expect.fail('A journaled write completes with a receipt')
        expect(ActionReceipt.guards.Completed(first.receipt)).toBe(true)
        const { outcome: again } = yield* useTool(actor, request)
        expect(again).toEqual(ToolOutcome.cases.Repeated.make({ receipt: first.receipt }))
        expect(yield* Ref.get(probe.calls)).toBe(sent + 1)
      }).pipe(Effect.scoped),
    )

    it.effect('reconciles unresolved Calendar attempts before the Gate and the locked claim', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const probe = yield* ConnectionProbe
        const cases = ['before', 'claim'].flatMap((entry) =>
          [false, true].flatMap((dispatching) =>
            ['found', 'absent', 'inconclusive'].map((result) => ({ entry, dispatching, result })),
          ),
        )
        for (const { entry, dispatching, result } of cases) {
          const { actor, owner, threadId, write } = yield* writer()
          const request = write({ record: 9 })
          yield* database.run(
            database
              .update(connections)
              .set({ service: ServiceId.make('google/calendar') })
              .where(eq(connections.id, request.connectionId)),
          )
          const target = ActionTarget.cases.Connection.make({
            connectionId: request.connectionId,
            account: 'Calendar',
            tool: 'calendarApi.calendarEventsInsert',
            input: { path: { calendarId: 'primary' }, body: { summary: 'Retry proof' } },
          })
          const original = {
            personId: owner,
            id: operationOf.program(),
            threadId,
            runId: null,
            approvalId: null,
            target,
          }
          expect(Claim.guards.Fresh(yield* claim(original))).toBe(true)
          yield* prepareReconciliation(
            yield* (yield* ConnectionStore).get(actor, request.connectionId),
            target,
            original.id,
          )
          if (!dispatching)
            yield* settle(
              ActionReceipt.cases.Unknown.make({ operationId: original.id, observedAt: 0 }),
            )
          yield* Ref.set(
            probe.outcome,
            result === 'inconclusive'
              ? ExecutorCallOutcome.cases.OutcomeUnknown.make({})
              : ExecutorCallOutcome.cases.Completed.make({
                  value: { items: result === 'found' ? [{ id: 'event' }] : [] },
                }),
          )
          if (result === 'absent') yield* TestClock.adjust('10 minutes')
          const calls = yield* Ref.get(probe.calls)
          const attempt = { ...original, id: operationOf.program() }
          const checked =
            entry === 'before'
              ? answerBefore(attempt).pipe(
                  Effect.map((answer) =>
                    Option.isSome(answer)
                      ? Claim.cases.Answered.make({ receipt: answer.value })
                      : Claim.cases.Fresh.make({}),
                  ),
                )
              : claim(attempt)
          const outcome = yield* checked.pipe(Effect.result)
          expect(yield* Ref.get(probe.calls)).toBe(calls + 1)
          const inputs = yield* Ref.get(probe.inputs)
          expect(inputs.slice(-1).map(({ tool }) => tool)).toEqual([
            'calendarApi.calendarEventsList',
          ])
          if (result === 'inconclusive') {
            expect(outcome).toEqual(
              Result.fail(new ActionReconciliationRequired({ operationId: original.id })),
            )
            continue
          }
          const answer = Result.getOrThrow(outcome)
          if (result === 'found') {
            if (!Claim.guards.Answered(answer))
              return expect.fail('Applied action must return its receipt')
            expect(ActionReceipt.guards.Completed(answer.receipt)).toBe(true)
            expect(answer.receipt.operationId).toBe(original.id)
          } else {
            expect(Claim.guards.Fresh(answer)).toBe(true)
            if (entry === 'claim') {
              const rows = yield* database.run(
                database
                  .select({ retryOf: actions.retryOf })
                  .from(actions)
                  .where(eq(actions.id, attempt.id)),
              )
              expect(rows).toEqual([{ retryOf: original.id }])
            }
          }
        }
      }).pipe(Effect.scoped),
    )

    it.effect(
      'holds the exact retry of an unknown write until reconciliation proves it was not applied',
      () =>
        Effect.gen(function* () {
          const { actor, owner, write } = yield* writer()
          const probe = yield* ConnectionProbe
          const database = yield* Database
          yield* Ref.set(probe.outcome, ExecutorCallOutcome.cases.OutcomeUnknown.make({}))
          const lost = write({ record: 7 })
          const { outcome: first } = yield* useTool(actor, lost)
          if (!ToolOutcome.guards.OutcomeUnknown(first) || first.receipt === null)
            return expect.fail('A lost write answers Unknown with its operation')
          const operationId = first.receipt.operationId
          const sent = yield* Ref.get(probe.calls)
          // The runtime retrying the same call learns it is still unknown; nothing is sent.
          const { outcome: retried } = yield* useTool(actor, lost)
          expect(retried).toEqual(ToolOutcome.cases.OutcomeUnknown.make({ receipt: first.receipt }))
          // A new call of the exact same act is refused, before any Gate decision or send.
          const checked = (yield* Ref.get(probe.checked)).length
          const refused = yield* useTool(actor, write({ record: 7 })).pipe(Effect.flip)
          expect(refused).toEqual(new ActionReconciliationRequired({ operationId }))
          expect((yield* Ref.get(probe.checked)).length).toBe(checked)
          expect(yield* Ref.get(probe.calls)).toBe(sent)
          // Unrelated work in the same Thread is not held.
          yield* Ref.set(
            probe.outcome,
            ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }),
          )
          const { outcome: other } = yield* useTool(actor, write({ record: 8 }))
          expect(ToolOutcome.guards.Completed(other)).toBe(true)
          expect(yield* Ref.get(probe.calls)).toBe(sent + 1)
          // A provider with no lookup cannot prove absence: still held.
          const unsure = yield* reconcile(owner, operationId).pipe(
            Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Unsupported.make({}))),
          )
          expect(ActionReconciliation.guards.Inconclusive(unsure.reconciliation)).toBe(true)
          const stillRefused = yield* useTool(actor, write({ record: 7 })).pipe(Effect.flip)
          expect(stillRefused).toEqual(new ActionReconciliationRequired({ operationId }))
          const earlyAbsent = yield* reconcile(owner, operationId).pipe(
            Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Absent.make({}))),
          )
          expect(earlyAbsent.reconciliation._tag).toBe('Inconclusive')
          yield* TestClock.adjust('10 minutes')
          // The provider's own lookup finds no such operation: a fresh send is allowed and names it.
          const absent = yield* reconcile(owner, operationId).pipe(
            Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Absent.make({}))),
          )
          expect(ActionReconciliation.guards.NotApplied(absent.reconciliation)).toBe(true)
          const { outcome: fresh } = yield* useTool(actor, write({ record: 7 }))
          if (!ToolOutcome.guards.Completed(fresh) || fresh.receipt === null)
            return expect.fail('The fresh send completes with its own receipt')
          expect(fresh.receipt.operationId).not.toBe(operationId)
          expect(yield* Ref.get(probe.calls)).toBe(sent + 2)
          const rows = yield* database.run(
            database
              .select({ retryOf: actions.retryOf })
              .from(actions)
              .where(eq(actions.id, fresh.receipt.operationId)),
          )
          expect(rows).toEqual([{ retryOf: operationId }])
          // A later lookup cannot overturn the definite answer already recorded.
          const settled = yield* reconcile(owner, operationId).pipe(
            Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Unsupported.make({}))),
          )
          expect(settled.reconciliation).toEqual(absent.reconciliation)
        }).pipe(Effect.scoped),
    )
  })
})
