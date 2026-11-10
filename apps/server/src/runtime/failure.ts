import { ModelFailureReason, RunFailure, RunId, ThreadId } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { FailureAttribute, observeFailures } from '../observability/failure.ts'

/** Only HTTP failure status numbers cross the telemetry boundary, never provider prose. */
export const ProviderStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))

/** Classification distinguishes failed model calls from delivery or unrecognized execution failures. */
const isModelFailure = Schema.is(ModelFailureReason)

/** The provider failed to answer; identities remain local and all diagnostics are closed values. */
class ModelProviderFailed extends Schema.TaggedError<ModelProviderFailed>()(
  'ModelProviderFailed',
  {
    threadId: ThreadId,
    runId: RunId,
    reason: ModelFailureReason,
    status: Schema.Option(ProviderStatus),
  },
  { title: 'The model provider failed' },
) {}

/** A terminal failure without provider evidence must not be mislabeled as a provider outage. */
class RunFailed extends Schema.TaggedError<RunFailed>()(
  'RunFailed',
  {
    threadId: ThreadId,
    runId: RunId,
    reason: RunFailure.pick(['Delivery', 'Unexplained']),
  },
  { title: 'The Run failed' },
) {}

/** Give a value settlement an actual failed span before answering it, using the normal recorder.
 * Only typed, classified evidence crosses, never provider prose or a cause. */
const failRun = Effect.fn('Runtime.failedRun')(function* (input: {
  readonly threadId: ThreadId
  readonly runId: RunId
  readonly reason: RunFailure
  readonly status: Option.Option<number>
}) {
  // Delivery and unrecognized execution failures have their own tag, without model diagnostics.
  const attributes = isModelFailure(input.reason)
    ? Option.match(input.status, {
        onNone: () => ({ [FailureAttribute.modelReason]: input.reason }),
        onSome: (status) => ({
          [FailureAttribute.modelReason]: input.reason,
          [FailureAttribute.modelStatus]: status,
        }),
      })
    : {}
  yield* Effect.annotateCurrentSpan(attributes)
  const failure = isModelFailure(input.reason)
    ? new ModelProviderFailed({ ...input, reason: input.reason })
    : new RunFailed({ threadId: input.threadId, runId: input.runId, reason: input.reason })
  return yield* Effect.fail(failure).pipe(
    observeFailures('runtime'),
    Effect.annotateLogs(attributes),
  )
})

/** Reporting answers only the failure it just constructed; settlement publishing continues. */
export const recordRunFailure = (input: Parameters<typeof failRun>[0]) =>
  failRun(input).pipe(Effect.catchTag(['ModelProviderFailed', 'RunFailed'], () => Effect.void))
