import { Effect } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import { PhoneCallRequest, RingWait } from '@vivid/contracts'

/**
 * The laptop-to-phone ring relay on the server (`/api/ring`, same origin through the Vite proxy).
 * The laptop places a ring; the phone waits for one, 25 seconds at a time.
 */

/** Tells the phone to ring with the call Vivid promised. */
const place = Effect.fn('Ring.place')(function* (call: PhoneCallRequest) {
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.post('/api/ring').pipe(
    HttpClientRequest.schemaBodyJson(PhoneCallRequest)(call),
  )
  yield* client.execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
})

/** Waits for the next ring, or `Quiet` when none arrived within the server's window. */
const wait = Effect.fn('Ring.wait')(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .get('/api/ring')
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
  return yield* HttpClientResponse.schemaBodyJson(RingWait)(response)
})

/** Promise boundary for the call stores: a failed ring settles as `false`. */
export const placeRing = (call: PhoneCallRequest) =>
  Effect.runPromise(
    place(call).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

/** A wait that could not reach the server fails its `Result`, so the phone can back off. */
export const waitForRing = () =>
  Effect.runPromise(wait().pipe(Effect.result, Effect.provide(FetchHttpClient.layer)))
