import * as Context from 'effect/Context'
import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { PhoneCallRequest, RingWait } from '@vivid/contracts'

/**
 * Carries a ring from the laptop, where the Person just talked to Vivid, to their phone, which
 * waits on `/api/ring` and turns the ring into an incoming-call screen. The voice itself runs
 * browser-to-Vapi on the phone; this relay only says "ring now, and here is what you know".
 *
 * DEMO RELAY: this is plain, unauthenticated HTTP, against the server rule that product calls go
 * through `VividRpc`. The web client has no signed-in session yet, and the relay carries only
 * scripted words, never an identity or a credential. Move it behind RPC auth before real use.
 */
export class Ringer extends Context.Service<
  Ringer,
  {
    readonly ring: (call: PhoneCallRequest) => Effect.Effect<void>
    readonly wait: Effect.Effect<RingWait>
  }
>()('vivid/Ringer') {}

/** How long one phone wait holds before answering `Quiet`, under common proxy idle timeouts. */
const waitWindow = Duration.seconds(25)

/**
 * A ring nobody collected within this window is stale and dropped. Without it a ring placed in
 * rehearsal sits in the queue and fires the moment the phone is opened for the real run.
 */
const freshFor = Duration.seconds(90)

/** A ring keeps the moment it was placed, so a phone can tell a fresh one from a leftover. */
interface Placed {
  readonly call: PhoneCallRequest
  readonly at: number
}

/**
 * A one-slot sliding queue: a ring placed while no phone is waiting is kept for the next wait,
 * and a newer ring replaces an older unanswered one, so the phone never rings twice for one talk.
 */
export const ringerLayer = Layer.effect(
  Ringer,
  Effect.gen(function* () {
    const pending = yield* Queue.sliding<Placed>(1)
    const ring = Effect.fn('Ringer.ring')(function* (call: PhoneCallRequest) {
      yield* Queue.offer(pending, { call, at: yield* Clock.currentTimeMillis })
    })
    const wait = Effect.gen(function* () {
      const taken = yield* Queue.take(pending).pipe(Effect.timeoutOption(waitWindow))
      if (Option.isNone(taken)) return RingWait.cases.Quiet.make({})
      const now = yield* Clock.currentTimeMillis
      const stale = now - taken.value.at > Duration.toMillis(freshFor)
      return stale
        ? RingWait.cases.Quiet.make({})
        : RingWait.cases.Ring.make({ call: taken.value.call })
    })
    return Ringer.of({ ring: (call) => ring(call), wait })
  }),
)

const encodeWait = HttpServerResponse.schemaJson(RingWait)

/** Laptop: ring the phone with the call Vivid promised. */
const ring = Effect.fn('Http.Ring.place')(function* () {
  const call = yield* HttpServerRequest.schemaBodyJson(PhoneCallRequest).pipe(Effect.option)
  if (Option.isNone(call))
    return HttpServerResponse.jsonUnsafe({ error: 'Invalid call' }, { status: 400 })
  const ringer = yield* Ringer
  yield* ringer.ring(call.value)
  return HttpServerResponse.empty({ status: 204 })
})

/** Phone: wait up to `waitWindow` for a ring. */
const wait = Effect.fn('Http.Ring.wait')(function* () {
  const ringer = yield* Ringer
  return yield* encodeWait(yield* ringer.wait)
})

export const ringRoutes = Layer.mergeAll(
  HttpRouter.add('POST', '/api/ring', ring()),
  HttpRouter.add('GET', '/api/ring', wait()),
)
