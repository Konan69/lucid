import {
  DEVICE_GRANT,
  Pairing,
  pairing,
  Wire,
  type Ending,
  type PairingTransport,
} from '@vivid/state'
import { Effect, Redacted, Stream } from 'effect'

/**
 * Signing this window in through the system browser: the web app's side of the device-code
 * exchange (`pairing.ts` in `@vivid/state`), which is how the desktop app signs in with Google.
 *
 * The desktop app's window is this web app, and Google refuses to sign anyone in inside an
 * embedded window. The phone has the same limit and already has the answer, so this is that
 * answer ported, not a second one (`apps/mobile/src/data/signing.ts` and `account.ts`): ask the
 * server for a code, open the system browser on the approval page for it with Google sign-in
 * started, and ask the server whether it has been approved until it has.
 *
 * It differs from the phone in one step, the last. The phone keeps the token the exchange ends
 * with and sends it as a bearer on every call. This app is authenticated by a cookie everywhere,
 * the live WebSocket included, so the token is traded once for the cookie of the same session
 * (`adoptSession`) and never kept: it is not stored, not put on the screen and not logged.
 *
 * Nothing here knows about the desktop app's bridge or the page: what opens the browser and what
 * happens on arrival are passed in, so the whole hand-off runs in a test on Effect's clock.
 */

/** Names this app to the server. The server records it with the code and checks it on exchange. */
const CLIENT_ID = 'vivid-desktop'

/** Posts one request of the exchange and hands back the answer unread: whether it was a yes, and its text. */
const ask = Effect.fn('Pairing.ask')(function* (
  path: string,
  fields: Readonly<Record<string, string>>,
) {
  const response = yield* Effect.tryPromise((signal) =>
    fetch(`/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(fields),
      signal,
    }),
  )
  const body = yield* Effect.tryPromise(() => response.text())
  return Wire.Answered({ ok: response.ok, body })
})

/**
 * One request of the exchange on the page's own origin, with "no answer" kept apart from "an
 * answer that says no", as the phone's `wire` does: the two are paced differently. No cookie is
 * needed; nobody is signed in here yet.
 */
const wire = (path: string, fields: Readonly<Record<string, string>>) =>
  ask(path, fields).pipe(Effect.catch(() => Effect.succeed(Wire.Unreachable())))

/** The exchange's two requests against the server this page is on. */
export const pairingTransport: PairingTransport = {
  requestCode: wire('device/code', { client_id: CLIENT_ID }),
  askToken: (deviceCode) =>
    wire('device/token', {
      grant_type: DEVICE_GRANT,
      device_code: Redacted.value(deviceCode),
      client_id: CLIENT_ID,
    }),
}

/**
 * Trades the session token the exchange ended with for that session's cookie, which is what
 * makes this window signed in. The server's `POST /api/auth/adopt-session`
 * (`apps/server/src/auth/cookie.ts`) authenticates the bearer and answers with Better Auth's own
 * signed session cookie; the browser keeps it, and from then on this window is like any other.
 *
 * It fails with the ending the screen has words for: no answer at all, or an answer that says no
 * (the session was signed out in the moment between the two requests).
 */
export const adoptSession = (token: Redacted.Redacted): Effect.Effect<void, Ending> =>
  Effect.tryPromise({
    try: (signal) =>
      fetch('/api/auth/adopt-session', {
        method: 'POST',
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
        credentials: 'same-origin',
        signal,
      }),
    catch: (): Ending => 'unreachable',
  }).pipe(
    Effect.flatMap((response) => (response.ok ? Effect.void : Effect.fail<Ending>('refused'))),
  )

/** Everything one hand-off touches outside itself. */
export interface Handoff {
  readonly transport: PairingTransport
  /** Opens the system browser on the approval page for this code. It cannot fail the hand-off. */
  readonly open: (userCode: string) => Effect.Effect<void>
  /** Makes the granted session this window's own. */
  readonly adopt: (token: Redacted.Redacted) => Effect.Effect<void, Ending>
  /** Puts where the exchange stands on the screen. */
  readonly show: (state: Pairing) => Effect.Effect<void>
  /** What being signed in leads to: the app starts again as the new Person. */
  readonly arrive: Effect.Effect<void>
}

/**
 * One whole hand-off, from asking for a code to being signed in or told why not. It is the
 * phone's `exchange` (`apps/mobile/src/data/signing.ts`) with this app's ending.
 *
 * Each state is shown as it is reached. The browser is opened once, when the code arrives. An
 * approval is not the end here: the token still has to become a cookie, and only when it has
 * does the app arrive. If that trade fails the screen says so as an ending, with the way to try
 * again, and the Person is not left on "You are in" in a window that is not.
 *
 * Interrupting it (the Person cancelled, or asked for a new code) stops the asking mid-wait.
 */
export const handOff = (way: Handoff): Effect.Effect<void> =>
  pairing(way.transport).pipe(
    Stream.runForEach((state) =>
      Pairing.$match(state, {
        Asking: () => way.show(state),
        Waiting: ({ userCode }) => Effect.andThen(way.show(state), way.open(userCode)),
        Approved: ({ token }) =>
          Effect.andThen(
            way.show(state),
            Effect.matchEffect(way.adopt(token), {
              onFailure: (why) => way.show(Pairing.Ended({ why })),
              onSuccess: () => way.arrive,
            }),
          ),
        Ended: () => way.show(state),
      }),
    ),
  )
