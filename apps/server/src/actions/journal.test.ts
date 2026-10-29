import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Duration, Effect, Option, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  ActionOperationMismatch,
  ActionReceipt,
  ActionReconciliation,
  ActionReconciliationRequired,
  ActionTarget,
  ConnectionId,
  ToolTaskId,
  ToolOutcome,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { EXECUTOR_EXCHANGE_LIMIT, ExecutorCallOutcome } from '../connections/executor.ts'
import { ConnectionStore } from '../connections/store.ts'
import {
  ConnectionProbe,
  connectionTestLayer,
  fixture,
  serviceId,
  nextTask,
} from '../connections/testing.ts'
import { useTool } from '../connections/tools.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ActionLookup, Lookup, claim, operationOf, reconcile } from './journal.ts'
import { actions } from './tables.ts'

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
    toolTaskId: ToolTaskId.make(nextTask()),
    connectionId: step.connection.id satisfies ConnectionId,
    tool: 'write',
    input,
    summary: 'Write the record',
    rationale: 'The Person asked for it',
  })
  return { actor, owner: ownerActor.person.id, write }
})

/** A provider lookup that answers for the test; the journal's rules around it are production. */
const lookingUp = (answer: Lookup) => ActionLookup.of({ look: () => Effect.succeed(answer) })

describe.skipIf(!testDatabaseConfigured)('Action journal', () => {
  layer(connectionTestLayer)((it) => {
    it.effect('answers a retried call with its first receipt and sends it once', () =>
      Effect.gen(function* () {
        const { actor, write } = yield* writer()
        const probe = yield* ConnectionProbe
        const sent = yield* Ref.get(probe.calls)
        const request = write({ record: 1 })
        const first = yield* useTool(actor, request)
        if (!ToolOutcome.guards.Completed(first) || first.receipt === null)
          return expect.fail('A journaled write completes with a receipt')
        expect(ActionReceipt.guards.Completed(first.receipt)).toBe(true)
        const again = yield* useTool(actor, request)
        expect(again).toEqual(ToolOutcome.cases.Repeated.make({ receipt: first.receipt }))
        expect(yield* Ref.get(probe.calls)).toBe(sent + 1)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'refuses a call whose operation was recorded for a different act, sending nothing',
      () =>
        Effect.gen(function* () {
          const { actor, write } = yield* writer()
          const probe = yield* ConnectionProbe
          const database = yield* Database
          const first = write({ record: 2 })
          const done = yield* useTool(actor, first)
          if (!ToolOutcome.guards.Completed(done) || done.receipt === null)
            return expect.fail('The first write completes with a receipt')
          const sent = yield* Ref.get(probe.calls)
          // The same runtime task naming a different act is never answered from the first record.
          const other = { ...write({ record: 3 }), toolTaskId: first.toolTaskId }
          const refused = yield* useTool(actor, other).pipe(Effect.flip)
          expect(refused).toEqual(
            new ActionOperationMismatch({ operationId: done.receipt.operationId }),
          )
          expect(yield* Ref.get(probe.calls)).toBe(sent)
          const rows = yield* database.run(
            database
              .select({ receipt: actions.receipt })
              .from(actions)
              .where(eq(actions.id, done.receipt.operationId)),
          )
          expect(rows).toEqual([{ receipt: done.receipt }])
        }).pipe(Effect.scoped),
    )

    it.effect('never lets a lookup call a send still within its bound not applied', () =>
      Effect.gen(function* () {
        const { actor, owner } = yield* writer()
        if (Option.isNone(actor.threadId)) return expect.fail('The writer acts in a Thread')
        const threadId = actor.threadId.value
        const id = operationOf.task(threadId, ToolTaskId.make(nextTask()))
        // A claim with no receipt yet: the send is under way.
        yield* claim({
          id,
          threadId,
          runId: null,
          approvalId: null,
          target: ActionTarget.cases.Connection.make({
            connectionId: ConnectionId.make('in-flight'),
            account: 'Records',
            tool: 'write',
            input: { record: 4 },
          }),
        })
        const absent = lookingUp(Lookup.cases.Absent.make({}))
        const early = yield* reconcile(owner, id).pipe(Effect.provideService(ActionLookup, absent))
        expect(ActionReconciliation.guards.Inconclusive(early.reconciliation)).toBe(true)
        yield* TestClock.adjust(Duration.sum(EXECUTOR_EXCHANGE_LIMIT, Duration.seconds(1)))
        const late = yield* reconcile(owner, id).pipe(Effect.provideService(ActionLookup, absent))
        expect(ActionReconciliation.guards.NotApplied(late.reconciliation)).toBe(true)
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
          const first = yield* useTool(actor, lost)
          if (!ToolOutcome.guards.OutcomeUnknown(first) || first.receipt === null)
            return expect.fail('A lost write answers Unknown with its operation')
          const operationId = first.receipt.operationId
          const sent = yield* Ref.get(probe.calls)
          // The runtime retrying the same call learns it is still unknown; nothing is sent.
          const retried = yield* useTool(actor, lost)
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
          const other = yield* useTool(actor, write({ record: 8 }))
          expect(ToolOutcome.guards.Completed(other)).toBe(true)
          expect(yield* Ref.get(probe.calls)).toBe(sent + 1)
          // A provider with no lookup cannot prove absence: still held.
          const unsure = yield* reconcile(owner, operationId).pipe(
            Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Unsupported.make({}))),
          )
          expect(ActionReconciliation.guards.Inconclusive(unsure.reconciliation)).toBe(true)
          const stillRefused = yield* useTool(actor, write({ record: 7 })).pipe(Effect.flip)
          expect(stillRefused).toEqual(new ActionReconciliationRequired({ operationId }))
          // The provider's own lookup finds no such operation: a fresh send is allowed and names it.
          const absent = yield* reconcile(owner, operationId).pipe(
            Effect.provideService(ActionLookup, lookingUp(Lookup.cases.Absent.make({}))),
          )
          expect(ActionReconciliation.guards.NotApplied(absent.reconciliation)).toBe(true)
          const fresh = yield* useTool(actor, write({ record: 7 }))
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
