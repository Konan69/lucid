import {
  causeAfter,
  IncidentCause,
  incidentHop,
  RunFailure,
  RunId,
  RuntimeSettlement,
  type PersonId,
} from '@vivid/contracts'
import { Effect, Option, Predicate, Schedule, Schema } from 'effect'
import { ProviderStatus } from './failure.ts'
import { RuntimeRejected, type RuntimeTransportFailed } from './transport.ts'

/** A runtime verdict is the only authority that ends an admitted Run. */
export const Settlement = Schema.TaggedUnion({
  Completed: { reply: Schema.String, responseId: RunId },
  Failed: { reason: RunFailure, providerStatus: Schema.optionalKey(ProviderStatus) },
  Stopped: {},
  Unknown: {},
})
export type Settlement = typeof Settlement.Type

const isRejected = Schema.is(RuntimeRejected)

/**
 * Observation gave up: nobody knows how the Run ended. The observer stores it as `Unknown`, which
 * keeps no cause because `Settlement` is also the persisted shape of an owed notice
 * (`notifications/delivery.ts` `RunNotice`); the cause goes to the `RunLost` Incident instead.
 */
export class SettlementLost extends Schema.TaggedError<SettlementLost>()(
  'SettlementLost',
  { cause: IncidentCause },
  { title: 'Run settlement could not be observed' },
) {}

/** A settlement lost in the server's own `operation`, before any cell answered: `tag` says why. */
export const lostHere = (operation: string, tag: string) =>
  SettlementLost.make({
    cause: [incidentHop({ service: 'server', operation, tag, status: Option.none(), issues: [] })],
  })

/**
 * Why a Run ended `Failed`, from what its settlement carries: the cell's category, and the model's
 * hop when the provider answered with a status. The cell sends no chain of its own for a failed
 * settlement (`RuntimeSettlement.Failed`), so these are the hops that can be told.
 */
export const failedCause = (
  failed: Extract<Settlement, { readonly _tag: 'Failed' }>,
): IncidentCause => {
  const cell = incidentHop({
    service: 'cell',
    operation: 'Runtime.settled',
    tag: failed.reason,
    status: Option.none(),
    issues: [],
  })
  return failed.providerStatus === undefined
    ? [cell]
    : [
        cell,
        incidentHop({
          service: 'model',
          operation: 'Runtime.settled',
          tag: failed.reason,
          status: Option.some(failed.providerStatus),
          issues: [],
        }),
      ]
}

/** Person-local response numbers need a global claim key so channels send joined answers once. */
export const settlementOf = (settled: RuntimeSettlement, personId: PersonId): Settlement =>
  RuntimeSettlement.match(settled, {
    Done: ({ answeredBy, reply, toolCalls }): Settlement =>
      reply.trim().length === 0 && toolCalls === 0
        ? Settlement.cases.Failed.make({ reason: 'NoAnswer' })
        : Settlement.cases.Completed.make({
            reply,
            responseId: RunId.make(`response_${personId}_${answeredBy}`),
          }),
    Failed: ({ failure, status }): Settlement =>
      status === undefined
        ? Settlement.cases.Failed.make({ reason: failure })
        : Settlement.cases.Failed.make({ reason: failure, providerStatus: status }),
    Stopped: (): Settlement => Settlement.cases.Stopped.make({}),
  })

/**
 * Pi holds the request until settlement. Reconnection never imposes a product deadline on its Run.
 * What is not retried is a refusal that will not change (the cell does not know the submission),
 * and observation gives up on it as `SettlementLost`, keeping the cell's chain.
 */
export const observeRun = Effect.fn('Durable.observe')(function* (
  read: Effect.Effect<Settlement, RuntimeTransportFailed | RuntimeRejected>,
) {
  return yield* read.pipe(
    Effect.retry({
      schedule: Schedule.spaced('1 second'),
      while: (error) =>
        Predicate.isTagged(error, 'RuntimeTransportFailed') ||
        (isRejected(error) && error.refusal.error === 'Unavailable'),
    }),
    Effect.mapError((error) => {
      const hop = incidentHop({
        service: 'server',
        operation: 'Durable.observe',
        tag: error._tag,
        status: Option.none(),
        issues: [],
      })
      return SettlementLost.make({
        cause: isRejected(error) ? causeAfter(hop, error.refusal.cause) : [hop],
      })
    }),
  )
})
