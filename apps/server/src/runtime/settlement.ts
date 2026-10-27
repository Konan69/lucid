import { RunFailure, RunId, RuntimeSettlement, type PersonId } from '@vivid/contracts'
import { Effect, Option, Predicate, Schedule, Schema } from 'effect'
import { ProviderStatus } from './failure.ts'
import { RuntimeRejected } from './transport.ts'

/** A runtime verdict is the only authority that ends an admitted Run. */
export const Settlement = Schema.TaggedUnion({
  Completed: { reply: Schema.String, responseId: RunId },
  Failed: { reason: RunFailure, providerStatus: Schema.optionalKey(ProviderStatus) },
  Stopped: {},
  Unknown: {},
})
export type Settlement = typeof Settlement.Type

const isRejected = Schema.is(RuntimeRejected)

/** Person-local response numbers need a global claim key so channels send joined answers once. */
export const settlementOf = (
  settled: RuntimeSettlement,
  personId: PersonId,
): Option.Option<Settlement> =>
  RuntimeSettlement.match(settled, {
    Pending: () => Option.none<Settlement>(),
    Done: ({ answeredBy, reply, toolCalls }) =>
      Option.some(
        reply.trim().length === 0 && toolCalls === 0
          ? Settlement.cases.Failed.make({ reason: 'NoAnswer' })
          : Settlement.cases.Completed.make({
              reply,
              responseId: RunId.make(`response_${personId}_${answeredBy}`),
            }),
      ),
    Failed: ({ failure, status }) =>
      Option.some(
        status === undefined
          ? Settlement.cases.Failed.make({ reason: failure })
          : Settlement.cases.Failed.make({ reason: failure, providerStatus: status }),
      ),
    Stopped: () => Option.some(Settlement.cases.Stopped.make({})),
  })

/** Pi holds pending reads. Transport reconnection never imposes a product deadline on its Run. */
export const observeRun = Effect.fn('Durable.observe')(function* <
  E extends { readonly _tag: string },
>(read: Effect.Effect<Option.Option<Settlement>, E>) {
  const result = yield* read.pipe(
    Effect.retry({
      schedule: Schedule.spaced('1 second'),
      while: (error) =>
        Predicate.isTagged(error, 'RuntimeTransportFailed') ||
        (isRejected(error) && error.refusal.error === 'Unavailable'),
    }),
    Effect.repeat({ while: Option.isNone }),
    Effect.catch(() => Effect.succeedSome(Settlement.cases.Unknown.make({}))),
  )
  return Option.getOrElse(result, () => Settlement.cases.Unknown.make({}))
})
