import {
  DEVICE_GRANT,
  Pairing,
  pairing,
  Wire,
  type Ending,
  type PairingTransport,
} from '@vivid/state'
import type { PairingClient } from '@vivid/contracts/auth'
import type { VividAppBridge } from '@vivid/desktop/bridge'
import { Data, Duration, Effect, Option, Predicate, Redacted, Schema, Stream } from 'effect'

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

/**
 * Names this app to the server, which issues a code to Vivid's own apps only and tells the Person
 * approving it which one asked (`PairingClient`).
 */
const CLIENT_ID: PairingClient = 'vivid-desktop'

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
 * How this window signs in with Google.
 *
 * - `Browser`: an ordinary browser tab. Google sign-in is a redirect, and none of this runs.
 * - `Shell`: the desktop app, with the capability to open an approval page in the system browser.
 * - `Outdated`: a desktop app installed before that capability existed. Its window still cannot
 *   run Google's sign-in, and it has no way to hand the Person to a browser, so Google is not
 *   offered there at all: a button that cannot work is worse than a line that says to update.
 */
export type Way = Data.TaggedEnum<{
  Browser: {}
  Shell: { readonly openApproval: VividAppBridge['openApproval'] }
  Outdated: {}
}>
export const Way = Data.taggedEnum<Way>()

/**
 * The one thing read off the desktop app's bridge here: the capability to open an approval page,
 * present as a function. Anything else there, or nothing, is a shell that cannot do it.
 */
const ApprovalBridge = Schema.Struct({
  openApproval: Schema.declare((value): value is VividAppBridge['openApproval'] =>
    Predicate.isFunction(value),
  ),
})
const decodeApprovalBridge = Schema.decodeUnknownOption(ApprovalBridge)

/**
 * Reads which way this window has from the desktop app's bridge, when there is one. The web app
 * and the shell are released separately, so what an installed shell put on the window is unknown
 * input and is decoded here, once: `openApproval` is this window's only if it is a function
 * there, whatever the bridge's type says today.
 */
export const wayIn = (bridge: Option.Option<unknown>): Way =>
  Option.match(bridge, {
    onNone: () => Way.Browser(),
    onSome: (shell) =>
      Option.match(decodeApprovalBridge(shell), {
        onNone: () => Way.Outdated(),
        onSome: ({ openApproval }) => Way.Shell({ openApproval }),
      }),
  })

/** The system browser could not be opened on the approval page: the shell refused or failed. */
export class BrowserUnopened extends Schema.TaggedError<BrowserUnopened>()(
  'BrowserUnopened',
  {},
  { title: 'The system browser could not be opened' },
) {}

/** The server answered the trade with a no: the session ended before it became a cookie. */
export class AdoptionRefused extends Schema.TaggedError<AdoptionRefused>()(
  'AdoptionRefused',
  {},
  { title: 'The session could not be adopted' },
) {}

/** The trade got no answer, or none in time. The token is still good and the trade can be retried. */
export class AdoptionUnfinished extends Schema.TaggedError<AdoptionUnfinished>()(
  'AdoptionUnfinished',
  {},
  { title: 'Adopting the session did not finish' },
) {}

/**
 * Trades the session token the exchange ended with for that session's cookie, which is what
 * makes this window signed in. The server's `POST /api/auth/adopt-session`
 * (`apps/server/src/auth/cookie.ts`) authenticates the bearer and answers with Better Auth's own
 * signed session cookie; the browser keeps it, and from then on this window is like any other.
 * The request has no body, which the server insists on, and the browser names this page's origin
 * on it, which the server checks.
 *
 * Its two failures are handled differently, so they are two errors: an answer that says no cannot
 * be retried, and no answer can.
 */
export const adoptSession = (token: Redacted.Redacted) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch('/api/auth/adopt-session', {
        method: 'POST',
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
        credentials: 'same-origin',
        signal,
      }),
    catch: () => new AdoptionUnfinished({}),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok ? Effect.void : Effect.fail(new AdoptionRefused({})),
    ),
  )

/** Whether the system browser is open on the approval page, as far as this window knows. */
export type Opened = 'opening' | 'opened' | 'unopened'

/**
 * Where a hand-off stands, which is exactly what the waiting card draws. It is the shared
 * exchange's states (`Pairing`) with what only this app has: a browser to open, and a token to
 * trade for a cookie.
 *
 * - `Asking`: waiting for the server to issue a code.
 * - `Waiting`: the code is on screen and the window is asking whether it has been approved.
 *   `browser` says whether the system browser opened, so a refusal from the shell is seen.
 * - `Adopting`: approved; the token is being traded for the cookie.
 * - `Unfinished`: approved, but the trade got no answer in time. The token is held so the trade
 *   can be tried again, and is dropped with this state when the Person cancels.
 * - `Ended`: it will not complete, and a new code is needed to try again.
 */
export type Handing = Data.TaggedEnum<{
  Asking: {}
  Waiting: { readonly userCode: string; readonly browser: Opened }
  Adopting: {}
  Unfinished: { readonly token: Redacted.Redacted }
  Ended: { readonly why: Ending }
}>
export const Handing = Data.taggedEnum<Handing>()

/** Everything one hand-off touches outside itself. */
export interface Handoff {
  readonly transport: PairingTransport
  /** Opens the system browser on the approval page for this code. */
  readonly open: (userCode: string) => Effect.Effect<void, BrowserUnopened>
  /** Makes the granted session this window's own. */
  readonly adopt: (
    token: Redacted.Redacted,
  ) => Effect.Effect<void, AdoptionRefused | AdoptionUnfinished>
  /** Puts where the hand-off stands on the screen. */
  readonly show: (state: Handing) => Effect.Effect<void>
  /** What being signed in leads to: the app starts again as the new Person. */
  readonly arrive: Effect.Effect<void>
}

/**
 * How long the trade may take. It is one small request to the server the window was just talking
 * to, so a quarter of a minute without an answer means it is not coming; the card then offers to
 * try again instead of saying "You are in" for ever over a window that is not.
 */
export const ADOPT_WITHIN = Duration.seconds(15)

/**
 * Opens the browser for a code and says how that went. The code is shown first and stays shown
 * either way: a browser that did not open is not the end, because the code is still good and the
 * card offers to open it again. What changes is that the card says so.
 */
export const opening = (way: Pick<Handoff, 'open' | 'show'>, userCode: string) =>
  Effect.andThen(
    way.show(Handing.Waiting({ userCode, browser: 'opening' })),
    Effect.matchEffect(way.open(userCode), {
      onFailure: () => way.show(Handing.Waiting({ userCode, browser: 'unopened' })),
      onSuccess: () => way.show(Handing.Waiting({ userCode, browser: 'opened' })),
    }),
  )

/**
 * Trades an approved token for the cookie and arrives, within `ADOPT_WITHIN`. A no from the
 * server ends the hand-off. No answer, or none in time, leaves it `Unfinished` with the token,
 * which is the state this is run from again when the Person tries again.
 */
export const adopting = (
  way: Pick<Handoff, 'adopt' | 'show' | 'arrive'>,
  token: Redacted.Redacted,
) =>
  Effect.andThen(
    way.show(Handing.Adopting()),
    way.adopt(token).pipe(
      Effect.timeoutOrElse({
        duration: ADOPT_WITHIN,
        orElse: () => Effect.fail(new AdoptionUnfinished({})),
      }),
      Effect.andThen(way.arrive),
      Effect.catchTags({
        AdoptionRefused: () => way.show(Handing.Ended({ why: 'refused' })),
        AdoptionUnfinished: () => way.show(Handing.Unfinished({ token })),
      }),
    ),
  )

/**
 * One whole hand-off, from asking for a code to being signed in or told why not. It is the
 * phone's `exchange` (`apps/mobile/src/data/signing.ts`) with this app's ending.
 *
 * Each state is shown as it is reached. The browser is opened once, when the code arrives. An
 * approval is not the end here: the token still has to become a cookie (`adopting`), and only
 * when it has does the app arrive.
 *
 * Interrupting it (the Person cancelled, or asked for a new code) stops the asking mid-wait.
 */
export const handOff = (way: Handoff): Effect.Effect<void> =>
  pairing(way.transport).pipe(
    Stream.runForEach((state) =>
      Pairing.$match(state, {
        Asking: () => way.show(Handing.Asking()),
        Waiting: ({ userCode }) => opening(way, userCode),
        Approved: ({ token }) => adopting(way, token),
        Ended: ({ why }) => way.show(Handing.Ended({ why })),
      }),
    ),
  )
