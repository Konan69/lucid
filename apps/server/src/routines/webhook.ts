import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { RoutineId } from '@vivid/contracts'
import { RoutineScheduler } from './scheduler.ts'
import { RoutineStore } from './store.ts'

class RoutinePayloadTooLarge extends Schema.TaggedError<RoutinePayloadTooLarge>()(
  'RoutinePayloadTooLarge',
  {},
  { title: 'Routine payload too large' },
) {}
const authority = Schema.Struct({
  id: RoutineId,
  authorization: Schema.String.check(Schema.isPattern(/^Bearer [A-Za-z0-9_-]{43}$/iu)),
})

/** Header and path values are decoded once before authority is looked up. */
const decodeAuthority = Schema.decodeUnknownEffect(authority)

/** Returns the same public denial for every absent or unusable webhook authority. */
const notFound = () =>
  HttpServerResponse.jsonUnsafe({ error: 'Routine not found' }, { status: 404 })

/** Bound bytes while consuming the stream, including chunked requests without Content-Length. */
const readPayload = Effect.fn('Http.Routine.readPayload')(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  // Effect rc.116's Web request stream rejects a null body; that represents a valid empty payload.
  if (request.source instanceof globalThis.Request && request.source.body === null) return ''
  const chunks: Array<Uint8Array> = []
  const length = yield* Stream.runFoldEffect(
    request.stream,
    () => 0,
    (previous, chunk) => {
      const next = previous + chunk.byteLength
      if (next > 64 * 1024) return Effect.fail(new RoutinePayloadTooLarge({}))
      chunks.push(chunk)
      return Effect.succeed(next)
    },
  )
  // Copy once after the limit has been checked; tiny network chunks must not cause quadratic copies.
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
})

/** The bearer credential authorizes one Routine; session cookies confer no authority here. */
const accept = Effect.fn('Http.Routine.webhook')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const route = yield* HttpRouter.RouteContext
  const decoded = yield* decodeAuthority({
    id: route.params.id,
    authorization: request.headers.authorization,
  }).pipe(Effect.option)
  if (Option.isNone(decoded)) return notFound()
  const store = yield* RoutineStore
  const record = yield* store.authorizeWebhook(
    decoded.value.id,
    Redacted.make(decoded.value.authorization.slice(7)),
  )
  const payload = yield* readPayload(request)
  const scheduler = yield* RoutineScheduler
  const occurrence = yield* scheduler.webhook(record, payload)
  return HttpServerResponse.jsonUnsafe({ occurrenceId: occurrence.id }, { status: 202 })
})

/** Typed failures map at the HTTP boundary; inaccessible Routines never disclose their existence. */
export const routineWebhookRoutes = HttpRouter.add(
  'POST',
  '/api/hooks/routines/:id',
  accept().pipe(
    Effect.catchTag('RoutineMissing', () => Effect.succeed(notFound())),
    Effect.catchTag('NotFound', () => Effect.succeed(notFound())),
    Effect.catchTag('RoutinePayloadTooLarge', () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: 'Payload too large' }, { status: 413 }),
      ),
    ),
    Effect.catchTag('HttpServerError', () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: 'Invalid request body' }, { status: 400 }),
      ),
    ),
    Effect.catchTag('RuntimeUnavailable', () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: 'Vivid is unavailable' }, { status: 503 }),
      ),
    ),
    Effect.catchTags({
      DatabaseFailure: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Routine could not run' }, { status: 500 }),
        ),
      DatabaseUnavailable: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Routine could not run' }, { status: 500 }),
        ),
      DatabaseConstraintViolation: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: 'Routine could not run' }, { status: 500 }),
        ),
    }),
  ),
)
