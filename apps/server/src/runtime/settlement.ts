import { RunFailure, RuntimeSettlement, type PersonId } from '@vivid/contracts'
import { Config, Effect, Option, Predicate, Schedule, Schema } from 'effect'
import { RuntimeRejected } from './transport.ts'

/** A response claim identifies an answer in one Person's store, independently of any product Run. */
export const ResponseId = Schema.String.pipe(Schema.brand('ResponseId'))
export type ResponseId = typeof ResponseId.Type

/** Channel replies claim one globally scoped product response id, not a Person-local Pi number. */
export const Settlement = Schema.TaggedUnion({
  Completed: { reply: Schema.String, responseId: ResponseId, toolCalls: Schema.Int },
  Failed: { reason: RunFailure, providerStatus: RuntimeSettlement.cases.Failed.fields.status },
  Stopped: {},
  Unknown: {},
})
export type Settlement = typeof Settlement.Type
const isRuntimeRejected = Schema.is(RuntimeRejected)

/** Request admission retries and settlement reads share the existing transport-loss allowance. */
export const runLossAllowance = Config.schema(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
  'VIVID_RUN_FIRST_TOKEN_TIMEOUT_MS',
).pipe(Config.withDefault(90_000))

export const responseTimeoutMillis = 60 * 60 * 1000

/** Pass closed categories through exactly. Empty words after real tools still constitute an answer. */
export const settlementOf = (
  settled: RuntimeSettlement,
  personId: PersonId,
): Option.Option<Settlement> =>
  RuntimeSettlement.match(settled, {
    Pending: () => Option.none<Settlement>(),
    Done: ({ answeredBy, reply, toolCalls }) =>
      reply.trim().length === 0 && toolCalls === 0
        ? Option.some(Settlement.cases.Failed.make({ reason: 'NoAnswer' }))
        : Option.some(
            Settlement.cases.Completed.make({
              reply,
              responseId: ResponseId.make(`response_${personId}_${answeredBy}`),
              toolCalls,
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

/**
 * A successful long-poll resets the transport-loss allowance. Pending never resets the one-hour
 * overall bound. Unknown submissions and permanent refusals cannot be recovered by reconnecting.
 */
export const observeRun = Effect.fn('Runtime.observeRun')(function* <
  E extends { readonly _tag: string },
>(read: Effect.Effect<Option.Option<Settlement>, E>, lossAllowance: number) {
  const recovered = read.pipe(
    Effect.retry({
      schedule: Schedule.spaced('1 second'),
      while: (error) =>
        Predicate.isTagged(error, 'RuntimeTransportFailed') ||
        (isRuntimeRejected(error) && error.refusal.error === 'Unavailable'),
    }),
    Effect.match({
      onFailure: () => Option.some(Settlement.cases.Unknown.make({})),
      onSuccess: (settlement) => settlement,
    }),
  )
  // A timeout supplies Unknown rather than a synthetic failed response. The loss timer covers
  // even a socket that never answers; an ordinary Pending is held at most 25 s by the runtime.
  const pass = recovered.pipe(
    Effect.timeoutOrElse({
      duration: lossAllowance,
      orElse: () => Effect.succeedSome(Settlement.cases.Unknown.make({})),
    }),
  )
  const result = yield* pass.pipe(
    Effect.repeat({ while: Option.isNone }),
    Effect.timeoutOrElse({
      duration: responseTimeoutMillis,
      orElse: () => Effect.succeedSome(Settlement.cases.Unknown.make({})),
    }),
  )
  return Option.getOrElse(result, () => Settlement.cases.Unknown.make({}))
})
