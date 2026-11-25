import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import {
  LoopbackPort,
  SignInAttempt,
  SignInChallenge,
  SignInReturn,
  readSignInReturn,
  signInStartAddress,
} from '@vivid/contracts/signin'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { SignInEnding, type SignInBrowser } from '../shared/bridge.ts'
import { ServerSettings } from '../shared/settings.ts'
import { landingPage } from './landing.ts'
import type { ThemeSurfaces } from './tokens.ts'

/**
 * Signing in with Google from the desktop app, the shell's half.
 *
 * Google will not sign anyone in inside an app's own window, so the Person does that part in
 * their system browser and the result has to find its way back to this app and no other. This is
 * a port of how Better Auth's own desktop integration does it (`@better-auth/electron` 1.7.5,
 * `requestAuth` and `authenticate` in `dist/client.mjs`): the app makes a name for the attempt
 * (`state`) and a secret (`codeVerifier`), sends the browser off with only the secret's SHA-256
 * digest (`codeChallenge`), and at the end a one-use code is traded together with the secret.
 * Whoever sees the code on its way back cannot use it without the secret.
 *
 * Two things differ from the reference, both on purpose:
 *
 * - **The return comes over a loopback address, not a link scheme.** The reference registers a
 *   custom protocol and the browser deep-links back into the app. A browser asks "Open this
 *   app?" before following such a link, every time, and the scheme is only registered for an
 *   installed app. Here the shell listens on `127.0.0.1` on a port the operating system picks,
 *   and the server sends the browser there (RFC 8252 section 7.3). A browser asks nothing before
 *   going to an address on the same computer, and it works in an app run from source.
 * - **The trade happens in the window, not here.** The reference's `authenticate` posts the code
 *   and the secret from the main process and then copies the session cookie into the window's
 *   session. Here the shell hands the code, the name and the secret to the window that asked,
 *   and the window trades them on its own origin, so Chromium keeps the cookie and the main
 *   process never holds a session.
 *
 * The reference's names do not survive: an attempt's `state` is its `SignInAttempt`, the
 * `codeVerifier` its verifier, the `codeChallenge` its `SignInChallenge` (`@vivid/contracts`).
 */

/**
 * How long an attempt waits for the browser to come back. The server keeps what it knows about
 * a sign-in for five minutes; a return after that could not be traded, so waiting longer would
 * only leave a port open for nothing.
 */
const ATTEMPT_LASTS = '5 minutes'

/**
 * How long the listener stays after a return, for the browser to follow the redirect to the
 * page it ends on. A browser follows a redirect at once, so this only ever runs out when the
 * tab was closed in that instant or the return was not made by a browser at all.
 */
const LANDING_WAIT = '10 seconds'

/**
 * The only host the listener binds: the IPv4 loopback literal, as RFC 8252 section 8.3 asks.
 * Never `localhost`, which a computer may resolve elsewhere, and never every interface, which
 * would offer the port to the network.
 */
const LOOPBACK = '127.0.0.1'

/** Where the browser is sent once its return has been read, so the code leaves its address bar. */
const LANDING_PATH = '/done'

/**
 * On every answer: nothing here may be kept by the browser or a proxy, and no later request may
 * carry this address (and the code in it) as its referrer.
 */
const ANSWER_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const

/** What the reference draws an attempt's name from: `generateRandomString(16, 'A-Z', 'a-z', '0-9')`. */
const NAME_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const NAME_LENGTH = 16
const SECRET_BYTES = 32

/** The source of an attempt's randomness. Injected so a test can tell the secret it expects. */
type Random = (size: number) => Uint8Array

/** The listener could not start: no port could be bound on the loopback address. */
class LoopbackUnavailable extends Schema.TaggedError<LoopbackUnavailable>()(
  'LoopbackUnavailable',
  {},
  { title: 'The loopback address could not be listened on' },
) {}

/**
 * A name for one attempt: sixteen letters and digits, each equally likely.
 *
 * The reference's generator (`createRandomStringGenerator` in `@better-auth/utils` 0.4.2
 * `dist/random.mjs`) draws twice as many bytes as it needs and throws away any byte of 248 or
 * more, because 256 is not a multiple of 62 and taking those would favour the first eight
 * letters. This does the same, drawing again for as long as too many were thrown away.
 */
const attemptName = (random: Random): SignInAttempt => {
  const fair = Math.floor(256 / NAME_LETTERS.length) * NAME_LETTERS.length
  let name = ''
  while (name.length < NAME_LENGTH) {
    const letters = [...random(NAME_LENGTH * 2)].flatMap((byte) =>
      byte < fair ? [NAME_LETTERS.charAt(byte % NAME_LETTERS.length)] : [],
    )
    name = `${name}${letters.join('')}`.slice(0, NAME_LENGTH)
  }
  return SignInAttempt.make(name)
}

/** What one attempt is started with. Only the name and the challenge ever leave the app. */
interface AttemptSecrets {
  readonly state: SignInAttempt
  readonly verifier: Redacted.Redacted
  readonly challenge: SignInChallenge
}

/**
 * The name, the secret and the secret's digest, as `requestAuth` makes them: the secret is the
 * base64url of 32 random bytes without padding, and the challenge is the base64url, again
 * without padding, of the SHA-256 of that text (PKCE's `S256`; `generateCodeChallenge` in
 * `better-auth/oauth2`). The secret is `Redacted` from here to the moment it is handed to the
 * window, so it cannot be logged on the way.
 */
const attemptSecrets = (random: Random): AttemptSecrets => {
  const verifier = Buffer.from(random(SECRET_BYTES)).toString('base64url')
  return {
    state: attemptName(random),
    verifier: Redacted.make(verifier),
    challenge: SignInChallenge.make(
      NodeCrypto.createHash('sha256').update(verifier).digest('base64url'),
    ),
  }
}

/**
 * Where a listener is in its one attempt. It reads one return, then serves one page, then is
 * done; the page it will serve is decided by the return and kept here until it is asked for.
 */
const Phase = Schema.TaggedUnion({
  Waiting: {},
  Returned: { page: Schema.String },
  Left: {},
})
type Phase = typeof Phase.Type

/** What one request to the listener is. Everything that is not the first two is a stray. */
const Arrival = Schema.TaggedUnion({
  /** The browser coming back from the server, for this attempt. */
  Return: { back: SignInReturn },
  /** The browser following the redirect to the page it ends on. */
  Landing: { page: Schema.String },
  /** Anything else: a request for an icon, another program probing the port, a wrong name. */
  Stray: {},
})
type Arrival = typeof Arrival.Type

const stray = Arrival.cases.Stray.make({})

/**
 * Decides what a request is, from its method, its target and where the listener is.
 *
 * A return is a `GET` of `/` whose query reads as one (`readSignInReturn`) and names this
 * attempt. The name is the whole check: the port is open to every program on the computer, and
 * only the browser the shell sent off was told the name. A return is read once; a second one,
 * even a copy of the first, is a stray. The page is a `GET` of its path with nothing after it,
 * and only once a return has been read.
 */
const arrivalOf = (
  request: NodeHttp.IncomingMessage,
  state: SignInAttempt,
  phase: Phase,
): Arrival => {
  // A request target is relative; the base only makes it parse and is never read back.
  const base = `http://${LOOPBACK}`
  const target = Option.map(
    Option.filter(
      Option.fromNullishOr(request.url),
      (url) => request.method === 'GET' && URL.canParse(url, base),
    ),
    (url) => new URL(url, base),
  )
  if (Option.isNone(target)) return stray
  const { pathname, search, searchParams } = target.value
  return Phase.match<Arrival>(phase, {
    Waiting: () =>
      Option.match(
        Option.filter(
          pathname === '/' ? readSignInReturn(Object.fromEntries(searchParams)) : Option.none(),
          (back) => back.state === state,
        ),
        { onNone: () => stray, onSome: (back): Arrival => Arrival.cases.Return.make({ back }) },
      ),
    Returned: ({ page }) =>
      pathname === LANDING_PATH && search === '' ? Arrival.cases.Landing.make({ page }) : stray,
    Left: () => stray,
  })
}

/** What a listener tells the attempt it belongs to. */
interface ListenerSignals {
  /** The browser came back, for this attempt. */
  readonly returned: Deferred.Deferred<SignInReturn>
  /** The browser has its last page (or went away while it was being sent). */
  readonly left: Deferred.Deferred<void>
}

/**
 * The listener's request handler. Node calls it outside any fiber, so it answers at once from
 * what it holds and tells the attempt through the two signals.
 *
 * - A return is answered with a redirect to the page, never with the page itself. The address
 *   the browser came back on has the code in it; a page answered there would leave the code in
 *   the address bar and in the tab's history for as long as the tab stays open.
 * - The page is served once. The listener stops taking connections before it answers, so by the
 *   time the browser shows the page nothing is listening, and `Connection: close` ends the one
 *   connection that is left. The attempt is told when that response is over, however it ended.
 * - A stray gets a 404 and changes nothing: the attempt goes on waiting.
 */
const receiving = (
  input: ListenerSignals & {
    readonly state: SignInAttempt
    readonly pages: Readonly<Record<SignInReturn['_tag'], string>>
  },
) => {
  let phase: Phase = Phase.cases.Waiting.make({})
  return (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    listener: NodeHttp.Server,
  ): void =>
    Arrival.match(arrivalOf(request, input.state, phase), {
      Return: ({ back }) => {
        phase = Phase.cases.Returned.make({ page: input.pages[back._tag] })
        response.writeHead(302, { ...ANSWER_HEADERS, Location: LANDING_PATH }).end()
        Deferred.doneUnsafe(input.returned, Effect.succeed(back))
      },
      Landing: ({ page }) => {
        phase = Phase.cases.Left.make({})
        listener.close()
        response.once('close', () => Deferred.doneUnsafe(input.left, Effect.void))
        response
          .writeHead(200, {
            ...ANSWER_HEADERS,
            'Content-Type': 'text/html; charset=utf-8',
            // The page has a style and nothing else; this says so to the browser.
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
            Connection: 'close',
          })
          .end(page)
      },
      Stray: () => {
        response.writeHead(404, ANSWER_HEADERS).end()
      },
    })
}

/** Binds a port the operating system picks, on the loopback address and nowhere else. */
const bound = (listener: NodeHttp.Server) =>
  Effect.callback<void, LoopbackUnavailable>((resume) => {
    listener.once('error', () => resume(Effect.fail(new LoopbackUnavailable({}))))
    listener.listen(0, LOOPBACK, () => resume(Effect.void))
  })

/**
 * Stops listening and ends every connection still open, then waits for Node to say it is done.
 * `close` alone waits for a browser's kept-alive connection, which may stay open for minutes.
 */
const unbound = (listener: NodeHttp.Server) =>
  Effect.callback<void>((resume) => {
    listener.close(() => resume(Effect.void))
    listener.closeAllConnections()
  })

/** The address Node reports for a bound listener, of which only the port is needed. */
const decodeBound = Schema.decodeUnknownEffect(Schema.Struct({ port: LoopbackPort }))

/**
 * Starts the listener for one attempt and gives back its port and its signals. The listener
 * belongs to the scope it is started in: when that closes, for any reason, nothing is listening.
 */
const listen = Effect.fn('DesktopSignIn.listen')(function* (
  state: SignInAttempt,
  pages: Readonly<Record<SignInReturn['_tag'], string>>,
) {
  const returned = yield* Deferred.make<SignInReturn>()
  const left = yield* Deferred.make<void>()
  const receive = receiving({ state, pages, returned, left })
  const listener: NodeHttp.Server = NodeHttp.createServer((request, response) =>
    receive(request, response, listener),
  )
  yield* Effect.acquireRelease(bound(listener), () => unbound(listener))
  const { port } = yield* decodeBound(listener.address()).pipe(
    Effect.mapError(() => new LoopbackUnavailable({})),
  )
  return { port, returned, left }
})

/** How a return reads to the window: the code with this attempt's secret, or that there is none. */
const endingOf = (back: SignInReturn, secrets: AttemptSecrets): SignInEnding =>
  SignInReturn.match<SignInEnding>(back, {
    Granted: ({ code, state }) =>
      SignInEnding.cases.Granted.make({
        code,
        state,
        verifier: Redacted.value(secrets.verifier),
      }),
    Failed: () => SignInEnding.cases.Failed.make({}),
  })

/** No port could be bound: say so in the log, and tell `begin` there is nothing to open. */
const unheard = (listening: Deferred.Deferred<Option.Option<LoopbackPort>>) =>
  Effect.logWarning('desktop: Google sign-in could not listen on the loopback address').pipe(
    Effect.andThen(Deferred.succeed(listening, Option.none())),
  )

/**
 * One attempt, from listening to its last page. `listening` is told the port as soon as there
 * is one, or that there is none. Its listener is scoped to this program, so every way it can
 * end, interruption included, closes the port.
 *
 * The order at the end matters. A return is said to the window at once, while the listener
 * stays to serve the page. Running out of time is said only after the scope has closed, so
 * `Expired` always means nothing is listening any more. That last line is also a no-op for
 * every attempt that has already ended: an ending is completed once.
 */
const attend = Effect.fn('DesktopSignIn.attend')(function* (input: {
  readonly secrets: AttemptSecrets
  readonly pages: Readonly<Record<SignInReturn['_tag'], string>>
  readonly focus: () => void
  readonly ended: Deferred.Deferred<SignInEnding>
  readonly listening: Deferred.Deferred<Option.Option<LoopbackPort>>
}) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const listener = yield* listen(input.secrets.state, input.pages)
      yield* Deferred.succeed(input.listening, Option.some(listener.port))
      const back = yield* Deferred.await(listener.returned).pipe(
        Effect.timeoutOption(ATTEMPT_LASTS),
      )
      if (Option.isNone(back)) return
      yield* Deferred.succeed(input.ended, endingOf(back.value, input.secrets))
      // The Person is in their browser; the app they are being signed in to comes forward.
      yield* Effect.sync(() => input.focus())
      yield* Deferred.await(listener.left).pipe(Effect.timeoutOption(LANDING_WAIT))
    }),
  ).pipe(Effect.catchTag('LoopbackUnavailable', () => unheard(input.listening)))
  yield* Deferred.succeed(input.ended, SignInEnding.cases.Expired.make({}))
})

/** What the shell is given to sign in with. Each is the app's own; a test supplies its own. */
export interface SignInDependencies {
  /** The server the shell has saved, now. The address is built from this and nothing else. */
  readonly server: () => ServerSettings
  /** Hands an address to the system browser. */
  readonly open: (
    address: string,
  ) => Effect.Effect<void, { readonly _tag: 'ExternalUrlOpenFailed' }>
  /** Cryptographically random bytes. */
  readonly random: Random
  /** Brings the app's window to the front, where the Person is about to be signed in. */
  readonly focus: () => void
  /** The page and ink the native window is painted with, for the page the browser ends on. */
  readonly surfaces: ThemeSurfaces
}

/** Signing in with Google, as the bridge asks for it. Mirrors `VividSignInBridge`. */
export interface GoogleSignIn {
  /** Starts an attempt, replacing one in progress, and says whether the browser opened. */
  readonly begin: Effect.Effect<SignInBrowser>
  /** Opens the browser again on the same address, for the attempt in progress. */
  readonly reopen: Effect.Effect<SignInBrowser>
  /** How the attempt ended, once it has. With no attempt, `Cancelled`. */
  readonly ended: Effect.Effect<SignInEnding>
  /** Ends the attempt `Cancelled` and stops listening. */
  readonly cancel: Effect.Effect<void>
}

/** The one attempt the shell knows about. */
interface Attempt {
  /** Where the browser was sent, kept to send it there again. */
  readonly address: string
  /** How it ended. Completed once, by whichever ending comes first. */
  readonly ended: Deferred.Deferred<SignInEnding>
  /** The listening and the waiting. Interrupting it stops both. */
  readonly fiber: Fiber.Fiber<void>
}

/**
 * Makes the shell's Google sign-in. There is at most one attempt; everything it starts lives in
 * the scope this is made in, so closing that scope (the app quitting) stops any listener.
 *
 * An attempt is one fiber (`attend`): it listens, waits up to five minutes for the browser to
 * come back, says how it ended, and stays a moment longer to give the browser its last page.
 *
 * An ending is handed to the window once. It is kept until `ended` is asked for it, so a return
 * that arrives before the window has started waiting is not lost; after that, and after
 * `cancel`, a new `begin` or a change of server, it is gone from here.
 */
export const googleSignIn = Effect.fn('DesktopSignIn.make')(function* (
  dependencies: SignInDependencies,
) {
  const lifetime = yield* Effect.scope
  // Starting and stopping each do several steps; one at a time keeps "at most one attempt" true
  // when two requests from the window overlap.
  const turn = yield* Semaphore.make(1)
  const pages = {
    Granted: landingPage(dependencies.surfaces, 'Granted'),
    Failed: landingPage(dependencies.surfaces, 'Failed'),
  }
  let current = Option.none<Attempt>()

  /** A browser that will not open is an answer, not a failure: the attempt goes on. */
  const browse = (address: string): Effect.Effect<SignInBrowser> =>
    dependencies.open(address).pipe(
      Effect.as<SignInBrowser>('opened'),
      Effect.catchTag('ExternalUrlOpenFailed', () => Effect.succeed<SignInBrowser>('unopened')),
    )

  /**
   * Ends whatever attempt there is as `Cancelled` and waits until its listener is closed. The
   * ending is said first, so the fiber's own last line cannot say `Expired` in its place.
   */
  const stop = Effect.fn('DesktopSignIn.stop')(function* () {
    const attempt = current
    current = Option.none()
    if (Option.isNone(attempt)) return
    yield* Deferred.succeed(attempt.value.ended, SignInEnding.cases.Cancelled.make({}))
    yield* Fiber.interrupt(attempt.value.fiber)
  })

  /**
   * Starts an attempt. With no server saved there is nowhere to sign in to: nothing listens and
   * the browser is not opened. A listener that cannot start is the same answer.
   *
   * The reference opens the browser with `shell.openExternal(url, { activate: true })`. The
   * shell's own opener (`openExternalUrl` in `window.ts`) passes no options, and `activate` is
   * true unless said otherwise (Electron's `OpenExternalOptions`), so the browser comes to the
   * front the same way.
   */
  const begin = Effect.fn('DesktopSignIn.begin')(function* () {
    const unopened: SignInBrowser = 'unopened'
    yield* stop()
    const server = dependencies.server()
    if (!ServerSettings.guards.Server(server)) return unopened
    const secrets = attemptSecrets(dependencies.random)
    const ended = yield* Deferred.make<SignInEnding>()
    const listening = yield* Deferred.make<Option.Option<LoopbackPort>>()
    const fiber = yield* attend({
      secrets,
      pages,
      focus: dependencies.focus,
      ended,
      listening,
    }).pipe(Effect.forkIn(lifetime))
    const port = yield* Deferred.await(listening)
    if (Option.isNone(port)) return unopened
    const address = signInStartAddress(server.origin, {
      challenge: secrets.challenge,
      state: secrets.state,
      port: port.value,
    })
    // With no address there is nothing to send a browser to, so nothing is left listening for one.
    if (Option.isNone(address)) {
      yield* Fiber.interrupt(fiber)
      return unopened
    }
    current = Option.some({ address: address.value, ended, fiber })
    return yield* browse(address.value)
  })

  /** Only an attempt still waiting for the browser has anywhere to send it. */
  const reopen = Effect.fn('DesktopSignIn.reopen')(function* () {
    const waiting = Option.filter(current, (attempt) => !Deferred.isDoneUnsafe(attempt.ended))
    if (Option.isNone(waiting)) return 'unopened' satisfies SignInBrowser
    return yield* browse(waiting.value.address)
  })

  /**
   * Waits for the attempt to end and hands its ending over, once: whoever is first to come back
   * from the wait takes it and the attempt is forgotten. Anyone else who was waiting on the same
   * attempt, or who waited on one that has since been cancelled or replaced, is told
   * `Cancelled`.
   *
   * The reference does the same thing in the same order: `authenticate` deletes the secret from
   * its map before it sends the trade, so the secret is used once however many times it is
   * asked for. The check and the forgetting below are one step with nothing awaited between
   * them, so two waiters cannot both pass.
   */
  const ended = Effect.fn('DesktopSignIn.ended')(function* () {
    const attempt = current
    if (Option.isNone(attempt)) return SignInEnding.cases.Cancelled.make({})
    const ending = yield* Deferred.await(attempt.value.ended)
    if (!Option.exists(current, (now) => now === attempt.value))
      return SignInEnding.cases.Cancelled.make({})
    current = Option.none()
    return ending
  })

  // When the app quits, a window still waiting is told the attempt is over instead of being
  // left with a promise that never settles. `stop` says so before it interrupts the listening.
  yield* Effect.addFinalizer(() => stop())

  const signIn: GoogleSignIn = {
    begin: Semaphore.withPermit(turn, begin()),
    reopen: reopen(),
    ended: ended(),
    cancel: Semaphore.withPermit(turn, stop()),
  }
  return signIn
})
