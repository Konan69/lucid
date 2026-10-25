import { SIGN_IN_PLACES, SignedIn, SignInTrade, type SignInArrival } from '@vivid/contracts/signin'
import { SignInBrowser, SignInEnding, type VividSignInBridge } from '@vivid/desktop/bridge'
import { Data, Duration, Effect, Option, Predicate, Schema } from 'effect'
import { googleAddresses } from './google'

/**
 * Signing the desktop app's window in with Google: the window's part of the contract in
 * `@vivid/contracts/signin`.
 *
 * The desktop app's window is this web app, and Google refuses to sign anyone in inside an app's
 * own window. So the shell opens the system browser on Google's account list and listens for the
 * answer (`VividSignInBridge` in the desktop app's `shared/bridge.ts`); the Person picks an
 * account there and does nothing else. The window's part is small: ask the shell to begin, say
 * where things stand, wait for the shell to say how it ended, and when it ended with a code,
 * trade the code and the app's secret for a session on this page's own origin. The answer to the
 * trade sets the session cookie, so Chromium keeps it and the shell never holds it.
 *
 * Nothing is typed, compared or approved.
 *
 * Nothing in the hand-off itself knows about the page or the bridge on it: what the shell
 * answers, how the trade is sent and what arriving does are passed in (`Handoff`), so the whole of
 * it runs in a test on Effect's clock.
 */

/**
 * How this window signs in with Google.
 *
 * - `Browser`: an ordinary browser tab. Google sign-in is a redirect, and none of this runs.
 * - `Shell`: the desktop app, with the capability to sign in through the system browser.
 * - `Unable`: a desktop app whose shell does not have that capability. Its window still cannot
 *   run Google's sign-in and has no way to hand the Person to a browser, so Google is not offered
 *   there and nothing is said in its place: a button that cannot work is not drawn, and the email
 *   form is the way in.
 */
export type Way = Data.TaggedEnum<{
  Browser: {}
  Shell: { readonly signIn: VividSignInBridge }
  Unable: {}
}>
export const Way = Data.taggedEnum<Way>()

/** One member of the capability, present as a function. What it answers is read when it does. */
const capability = <Name extends keyof VividSignInBridge>() =>
  Schema.declare((value): value is VividSignInBridge[Name] => Predicate.isFunction(value))

/**
 * The one thing read off the desktop app's bridge here: `signIn`, with all four of its members
 * present as functions. A shell with some of them is a shell this window cannot finish a sign-in
 * with, so it counts as having none.
 */
const SignInCapability = Schema.Struct({
  signIn: Schema.Struct({
    begin: capability<'begin'>(),
    reopen: capability<'reopen'>(),
    ended: capability<'ended'>(),
    cancel: capability<'cancel'>(),
  }),
})
const decodeCapability = Schema.decodeUnknownOption(SignInCapability)

/**
 * Reads which way this window has from the desktop app's bridge, when there is one. The web app
 * and the shell are released separately, so what an installed shell put on the window is unknown
 * input and is decoded here, once, whatever the bridge's type says today.
 *
 * The four functions are held in the object the decoding made, not the shell's own. They come
 * through Electron's context bridge as plain functions that read no receiver, so that is safe.
 */
export const wayIn = (bridge: Option.Option<unknown>): Way =>
  Option.match(bridge, {
    onNone: () => Way.Browser(),
    onSome: (shell) =>
      Option.match(decodeCapability(shell), {
        onNone: () => Way.Unable(),
        onSome: ({ signIn }) => Way.Shell({ signIn }),
      }),
  })

/**
 * The shell did not answer in a form this window can read: its promise was rejected (the shell's
 * own decoding refused the message), or what it answered is not what the contract says.
 */
export class ShellUnreadable extends Schema.TaggedError<ShellUnreadable>()(
  'ShellUnreadable',
  {},
  { title: 'The desktop app’s answer could not be read' },
) {}

/** The server answered the trade with a no, or with a yes this window could not read. */
export class TradeRefused extends Schema.TaggedError<TradeRefused>()(
  'TradeRefused',
  {},
  { title: 'The code could not be traded for a session' },
) {}

/** The trade got no answer, or none in time. */
export class TradeUnanswered extends Schema.TaggedError<TradeUnanswered>()(
  'TradeUnanswered',
  {},
  { title: 'Trading the code got no answer' },
) {}

const encodeTrade = Schema.encodeEffect(Schema.fromJsonString(SignInTrade))
const decodeSignedIn = Schema.decodeUnknownEffect(Schema.fromJsonString(SignedIn))

/**
 * Trades a code and the app's secret for a session: `POST` to `SIGN_IN_PLACES.trade` on this
 * page's own origin (`apps/server/src/auth/signin.ts`). The answer sets Better Auth's session
 * cookie, which is what makes this window signed in, and its body says whether the account was
 * just made. The browser names this page's origin on the request, which the server checks.
 *
 * Its two failures lead to different words, so they are two errors. The secret is written into
 * the request body here and nowhere else.
 *
 * A yes whose body cannot be read is a refusal too. The window may hold a session by then, but it
 * does not know which arrival this is, and it does not guess.
 */
export const tradeCode = Effect.fn('SignIn.tradeCode')(function* (trade: SignInTrade) {
  const body = yield* encodeTrade(trade).pipe(Effect.mapError(() => new TradeRefused({})))
  const answer = yield* Effect.tryPromise({
    // One signal owns headers and body. Ending the exchange must abort a body still arriving.
    try: (signal) =>
      fetch(SIGN_IN_PLACES.trade, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body,
        signal,
      }).then((response) => response.text().then((text) => ({ ok: response.ok, text }))),
    catch: () => new TradeUnanswered({}),
  })
  if (!answer.ok) return yield* new TradeRefused({})
  return yield* decodeSignedIn(answer.text).pipe(Effect.mapError(() => new TradeRefused({})))
})

/**
 * Why a hand-off stopped short of signing in.
 *
 * - `failed`: the browser came back without a code (the Person closed Google's page, for one).
 * - `expired`: nothing came back in the five minutes the shell listens.
 * - `refused`: the server said no to the trade, or what the shell handed over could not be read.
 * - `unreachable`: the trade got no answer in time.
 */
export type Why = 'failed' | 'expired' | 'refused' | 'unreachable'

/**
 * Where a hand-off stands, which is exactly what the card draws.
 *
 * - `Opening`: the shell has been asked to begin and has not answered yet.
 * - `Waiting`: the shell is listening for the browser. `browser` says whether the system browser
 *   opened, so one that did not is seen and the card offers to open it.
 * - `Finishing`: the browser came back with a code, and it is being traded for a session.
 * - `Ended`: it will not complete. A code is good once, so there is no step to try again; the
 *   only way forward is a new attempt.
 */
export type Handing = Data.TaggedEnum<{
  Opening: {}
  Waiting: { readonly browser: SignInBrowser }
  Finishing: {}
  Ended: { readonly why: Why }
}>
export const Handing = Data.taggedEnum<Handing>()

/** Everything one hand-off touches outside itself. */
export interface Handoff {
  /** Asks the shell to start an attempt. It answers whether the browser opened. */
  readonly begin: Effect.Effect<SignInBrowser, ShellUnreadable>
  /** Waits for the shell to say how the attempt ended. */
  readonly ended: Effect.Effect<SignInEnding, ShellUnreadable>
  /** Trades the code for a session, and answers which arrival this is. */
  readonly trade: (trade: SignInTrade) => Effect.Effect<SignedIn, TradeRefused | TradeUnanswered>
  /** Puts where the hand-off stands on the card. */
  readonly show: (state: Handing) => Effect.Effect<void>
  /** Takes the card away, back to the form. */
  readonly leave: Effect.Effect<void>
  /** What being signed in leads to: the app starts again as the new Person. */
  readonly arrive: (arrival: SignInArrival) => Effect.Effect<void>
}

/**
 * Bounds one sign-in code exchange that can hold a socket with no answer.
 * Source: unmeasured, retained fifteen-second request bound. Expiry is TradeUnanswered,
 * which the hand-off shows as unreachable. Cancellation aborts request and body together.
 */
export const TRADE_WITHIN = Duration.seconds(15)

const unreadable = () => new ShellUnreadable({})
const decodeBrowser = Schema.decodeUnknownEffect(SignInBrowser)
const decodeEnding = Schema.decodeUnknownEffect(SignInEnding)
const decodeTrade = Schema.decodeUnknownEffect(SignInTrade)

/**
 * One question put to the shell: a promise it may reject, of something not yet read. It is typed
 * as schema input, the way the desktop app types its own bridge ingress (`decodeBridgeResponse`).
 */
type Asking = () => Promise<typeof Schema.Unknown.Type>

/**
 * Asks the shell whether the browser opened (`begin` or `reopen`) and reads its answer.
 *
 * The web app and the shell are released separately, so what a shell answers is unknown input
 * whatever the bridge's type says, and this is where it is decoded, once. A promise the shell
 * rejects (its own decoding refused the message) and an answer that is not in the contract are
 * the same thing to this window: an answer it cannot read.
 */
export const browserSaid = (ask: Asking): Effect.Effect<SignInBrowser, ShellUnreadable> =>
  Effect.tryPromise({ try: ask, catch: unreadable }).pipe(
    Effect.flatMap(decodeBrowser),
    Effect.mapError(unreadable),
  )

/** Asks the shell how the attempt ended (`ended`) and reads its answer, as `browserSaid` does. */
export const endingSaid = (ask: Asking): Effect.Effect<SignInEnding, ShellUnreadable> =>
  Effect.tryPromise({ try: ask, catch: unreadable }).pipe(
    Effect.flatMap(decodeEnding),
    Effect.mapError(unreadable),
  )

/**
 * Trades what the shell handed over and arrives, within `TRADE_WITHIN`.
 *
 * The three values are text the shell passed across the bridge, known so far only not to be
 * empty, so they are decoded with the contract's own schema before anything is sent or shown.
 * Values that do not decode never reach the server, and the card never says it is signing the
 * Person in for them.
 */
const finishing = (way: Handoff, handed: typeof SignInEnding.cases.Granted.Type) =>
  decodeTrade(handed).pipe(
    Effect.mapError(() => new TradeRefused({})),
    Effect.tap(() => way.show(Handing.Finishing())),
    Effect.flatMap((trade) =>
      way.trade(trade).pipe(
        Effect.timeoutOrElse({
          duration: TRADE_WITHIN,
          orElse: () => Effect.fail(new TradeUnanswered({})),
        }),
      ),
    ),
    Effect.flatMap(({ arrival }) => way.arrive(arrival)),
    Effect.catchTags({
      TradeRefused: () => way.show(Handing.Ended({ why: 'refused' })),
      TradeUnanswered: () => way.show(Handing.Ended({ why: 'unreachable' })),
    }),
  )

/**
 * One whole hand-off, from the press to being signed in or told why not. Each state is shown as
 * it is reached.
 *
 * The order follows the shell's contract: `begin` answers as soon as the browser has been asked
 * to open, and only then is there an attempt whose end can be waited for. A shell that says
 * `Cancelled` ended the attempt for a reason that is not a fault (another one replaced it, or
 * none was running), so the card goes away and nothing is said.
 *
 * An answer from the shell that cannot be read ends it as `refused`: no browser is being listened
 * for that this window knows of, so waiting would be waiting for nothing.
 *
 * Interrupting it (the Person cancelled, or started again) stops it where it stands.
 */
export const handOff = (way: Handoff): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* way.show(Handing.Opening())
    const browser = yield* way.begin
    yield* way.show(Handing.Waiting({ browser }))
    const ending = yield* way.ended
    yield* SignInEnding.match(ending, {
      Granted: (handed) => finishing(way, handed),
      Failed: () => way.show(Handing.Ended({ why: 'failed' })),
      Expired: () => way.show(Handing.Ended({ why: 'expired' })),
      Cancelled: () => way.leave,
    })
  }).pipe(Effect.catch(() => way.show(Handing.Ended({ why: 'refused' }))))

/**
 * Asks the shell to open the browser for the attempt in progress, after it did not open, and
 * answers whether it did this time. An answer that cannot be read counts as a browser that did
 * not open: the attempt is still running in the shell, and the card's next step for the Person
 * is the same, to open it.
 */
export const reopening = (
  reopen: Effect.Effect<SignInBrowser, ShellUnreadable>,
): Effect.Effect<SignInBrowser> =>
  reopen.pipe(Effect.orElseSucceed((): SignInBrowser => 'unopened'))

/**
 * What is on the screen, and which attempt put it there. No state means the form is showing.
 * Attempts are counted so that something that started under one cannot write over the next.
 */
export interface Shown {
  readonly attempt: number
  readonly state: Option.Option<Handing>
}

/** Whether the card is still waiting for the browser, on this attempt. */
export const waitingOn = (shown: Shown, attempt: number): boolean =>
  shown.attempt === attempt &&
  Option.isSome(shown.state) &&
  Handing.$is('Waiting')(shown.state.value)

/**
 * The screen after the shell answered a request to reopen the browser. It changes only a card
 * still waiting on the attempt the request was made under. A code that arrived while the browser
 * was opening has already moved the card on, and "the browser opened" must not be painted over
 * that; nor over the form after a cancel, or over a later attempt. Otherwise it is handed back as
 * it was, the same value.
 */
export const reopened = (shown: Shown, attempt: number, browser: SignInBrowser): Shown =>
  waitingOn(shown, attempt) ? { attempt, state: Option.some(Handing.Waiting({ browser })) } : shown

/**
 * Where the app starts again once this window is signed in. A returning Person goes where they
 * were going. One whose account Google just made goes to the same place marked the way a first
 * Google arrival is in a browser tab (`googleAddresses`), so the landing adopts this computer's
 * time zone exactly as it does there (`adoptFirstArrival` in `account.ts`).
 */
export const landing = (destination: string, arrival: SignInArrival): string => {
  const { callbackURL, newUserCallbackURL } = googleAddresses(destination)
  return arrival === 'first' ? newUserCallbackURL : callbackURL
}
