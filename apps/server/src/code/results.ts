import type { CodemodeResult } from '@earendil-works/pi-codemode'
import { CodeFailure } from '@vivid/contracts/code'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { boundedNesting, budgets, bytes } from './budgets.ts'
import { printed } from './logs.ts'
import { PipeFailure, WorkerMessage } from './protocol.ts'

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

/** Pi's tagged failure values separate interpreter limits from host unavailability and guest errors. */
function guestFailure(error: Extract<CodemodeResult, { ok: false }>['error']) {
  if (error.kind === 'sandbox' || error.kind === 'aborted')
    return CodeFailure.cases.Unavailable.make({})
  if (/out of memory/i.test(error.message))
    return CodeFailure.cases.OverLimit.make({ limit: 'memory' })
  return error.kind === 'timeout'
    ? CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })
    : CodeFailure.cases.Threw.make({ message: error.message.slice(0, 500) })
}

/** JSON values and bounded printed lines travel together; images remain an explicit refusal. */
export const finish = Effect.fn('Code.finishGuest')(function* (result: CodemodeResult) {
  const logs = printed(result.output)
  const failed = (failure: CodeFailure) =>
    WorkerMessage.cases.Failed.make({ failure, logs: logs.logs, logsTruncated: logs.logsTruncated })
  if (!result.ok) return failed(guestFailure(result.error))
  if (result.output.some((item) => item.type === 'image'))
    return failed(
      CodeFailure.cases.Threw.make({ message: 'Programs return JSON or text, not images.' }),
    )
  // No return is a JSON null; printed output has its own ordered channel and is never a fake value.
  return yield* Effect.gen(function* () {
    const json = yield* guestJson(result.value === undefined ? null : result.value, budgets.result)
    const message = WorkerMessage.cases.Done.make({
      result: json,
      logs: logs.logs,
      logsTruncated: logs.logsTruncated,
    })
    // The parent alone knows receipt size and shrinks logs after reserving the value.
    // IPC reserves at most 32 KiB JSON plus 8 KiB logs and a bounded frame envelope.
    return message
  }).pipe(
    Effect.catchTag('CodePipeFailure', (failure) =>
      Effect.succeed(
        failed(
          failure.reason === 'size'
            ? CodeFailure.cases.OverLimit.make({ limit: 'result' })
            : CodeFailure.cases.Threw.make({
                message: 'Program result cannot be serialized as JSON.',
              }),
        ),
      ),
    ),
  )
})
