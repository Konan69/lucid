import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Effect, Option, Ref } from 'effect'
import {
  ActionReceipt,
  ActionReconciliation,
  ActionReconciliationRequired,
  ToolCallId,
  ToolOutcome,
  type ConnectionId,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { ExecutorCallOutcome } from '../connections/executor.ts'
import { ConnectionStore } from '../connections/store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from '../connections/testing.ts'
import { useTool } from '../connections/tools.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ActionLookup, Lookup, reconcile } from './journal.ts'
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
    toolCallId: ToolCallId.make(crypto.randomUUID()),
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
        const { outcome: first } = yield* useTool(actor, request)
        if (!ToolOutcome.guards.Completed(first) || first.receipt === null)
          return expect.fail('A journaled write completes with a receipt')
        expect(ActionReceipt.guards.Completed(first.receipt)).toBe(true)
        const { outcome: again } = yield* useTool(actor, request)
        expect(again).toEqual(ToolOutcome.cases.Repeated.make({ receipt: first.receipt }))
        expect(yield* Ref.get(probe.calls)).toBe(sent + 1)
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
