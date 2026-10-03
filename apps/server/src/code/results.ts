import type { CodemodeResult } from '@earendil-works/pi-codemode'
import { CodeFailure } from '@vivid/contracts/code'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { boundedNesting, budgets, bytes } from './budgets.ts'
import { encodeWorker, PipeFailure, WorkerMessage } from './protocol.ts'

const decodeGuestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** Serialize and check size/depth before recursive decoding. This is the pi SDK's unknown ingress. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public third-party SDK input is unknown; decoded once here.
export const guestJson = Effect.fn('Code.guestJson')(function* (input: unknown, maximum: number) {
  const text = yield* Effect.try({
    try: () => JSON.stringify(input),
    catch: () => new PipeFailure({ reason: 'invalid' }),
  })
  if (text === undefined) return yield* Effect.fail(new PipeFailure({ reason: 'invalid' }))
  if (bytes(text) > maximum || !boundedNesting(text))
    return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
  return yield* decodeGuestJson(text).pipe(
    Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
  )
})

/** Only JSON returns or text prints are supported; persistent store writes and images are discarded. */
export const finish = Effect.fn('Code.finishGuest')(
  function* (result: CodemodeResult) {
    if (!result.ok) {
      if (result.error.kind === 'sandbox' || result.error.kind === 'aborted')
        return WorkerMessage.cases.Failed.make({ failure: CodeFailure.cases.Unavailable.make({}) })
      if (/out of memory/i.test(result.error.message))
        return WorkerMessage.cases.Failed.make({
          failure: CodeFailure.cases.OverLimit.make({ limit: 'memory' }),
        })
      const failure =
        result.error.kind === 'timeout'
          ? CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })
          : CodeFailure.cases.Threw.make({ message: result.error.message.slice(0, 500) })
      return WorkerMessage.cases.Failed.make({ failure })
    }
    if (result.output.some((item) => item.type === 'image'))
      return WorkerMessage.cases.Failed.make({
        failure: CodeFailure.cases.Threw.make({
          message: 'Programs return JSON or text, not images.',
        }),
      })
    const value =
      result.value === undefined
        ? result.output
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
        : result.value
    const json = yield* guestJson(value, budgets.result)
    const message = WorkerMessage.cases.Done.make({ result: json })
    if (bytes(encodeWorker(message)) > budgets.result)
      return WorkerMessage.cases.Failed.make({
        failure: CodeFailure.cases.OverLimit.make({ limit: 'result' }),
      })
    return message
  },
  Effect.catchTag('CodePipeFailure', (failure) =>
    Effect.succeed(
      WorkerMessage.cases.Failed.make({
        failure:
          failure.reason === 'size'
            ? CodeFailure.cases.OverLimit.make({ limit: 'result' })
            : CodeFailure.cases.Threw.make({
                message: 'Program result cannot be serialized as JSON.',
              }),
      }),
    ),
  ),
)
