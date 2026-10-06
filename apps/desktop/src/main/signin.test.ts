import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import {
  SignInAttempt,
  SignInCode,
  SignInReturn,
  SignInStart,
  SIGN_IN_PLACES,
  signInReturnAddress,
} from '@vivid/contracts/signin'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as TestClock from 'effect/testing/TestClock'
import { SignInEnding } from '../shared/bridge.ts'
import { ServerAddress, ServerSettings } from '../shared/settings.ts'
import { googleSignIn } from './signin.ts'
import { loadThemeSurfaces } from './tokens.ts'

/**
 * These run the real listener: every request below is a real HTTP request to the port the shell
 * bound, made the way a browser makes it (redirects are not followed for it, so each hop can be
 * looked at). Nothing sleeps or polls. An ending is waited on through `ended`; time is the
 * test clock's; and "nothing is listening" is a connection the operating system refuses.
 */

const origin = ServerAddress.make('https://vivid.example')
const chosen = ServerSettings.cases.Server.make({ origin })
const cancelled = SignInEnding.cases.Cancelled.make({})
const code = SignInCode.make('Ab3'.repeat(10).concat('Zz'))

/** The design tokens the app reads at startup, so the page is checked in the app's real colours. */
const shipped = NodePath.resolve(
  import.meta.dirname,
  '../../../../packages/design/tokens/src/tokens.css',
)

/** The connection was refused or dropped: nothing answered on that port. */
class NothingListening extends Schema.TaggedError<NothingListening>()(
  'NothingListening',
  {},
  { title: 'Nothing answered on the loopback port' },
) {}

/** One request as a browser sends it, without following a redirect. */
const request = (address: string, method: 'GET' | 'POST') =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(address, { method, redirect: 'manual' })
      return {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      }
    },
    catch: () => new NothingListening({}),
  })
const get = (address: string) => request(address, 'GET')

/**
 * The shell's sign-in with the app's side of it stood in for: which server is saved, whether
 * the system browser opens, and the window to bring forward. Randomness, the listener and the
 * page are the real ones.
 */
const fixture = Effect.fn('fixture')(function* (server: ServerSettings) {
  const surfaces = yield* loadThemeSurfaces(shipped)
  const opened: string[] = []
  const seen = { opened, focused: 0, opens: true }
  const signIn = yield* googleSignIn({
    server: () => server,
    open: (address) =>
      seen.opens
        ? Effect.sync(() => {
            seen.opened.push(address)
          })
        : Effect.fail({ _tag: 'ExternalUrlOpenFailed' as const }),
    random: (size) => NodeCrypto.randomBytes(size),
    focus: () => {
      seen.focused += 1
    },
    surfaces,
  })
  return { signIn, seen }
})

/** What a `Granted` ending names, and nothing for any other ending. */
const grantOf = (ending: SignInEnding) =>
  SignInEnding.guards.Granted(ending)
    ? Option.some({ code: ending.code, state: ending.state })
    : Option.none()
/** The secret a `Granted` ending hands over. */
const secretOf = (ending: SignInEnding) =>
  SignInEnding.guards.Granted(ending) ? Option.some(ending.verifier) : Option.none()

const decodeStart = Schema.decodeUnknownEffect(SignInStart)

/** What the shell put on the address it opened, and the loopback address that answers it. */
const startOf = Effect.fn('startOf')(function* (address: string) {
  const opened = new URL(address)
  const start = yield* decodeStart(Object.fromEntries(opened.searchParams))
  const back = (value: SignInReturn) => signInReturnAddress(start.port, value)
  return {
    place: `${opened.origin}${opened.pathname}`,
    ...start,
    loopback: `http://127.0.0.1:${start.port}`,
    granted: back(SignInReturn.cases.Granted.make({ code, state: start.state })),
    failed: back(SignInReturn.cases.Failed.make({ state: start.state })),
    back,
  }
})

/** The one address the fixture's browser was sent to. */
const onlyOpened = Effect.fn('onlyOpened')(function* (opened: ReadonlyArray<string>) {
  expect(opened).toHaveLength(1)
  return yield* startOf(String(opened[0]))
})

describe('desktop Google sign-in', () => {
  it.effect('a good return gives the window the code and the secret behind the challenge', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      expect(yield* signIn.begin).toBe('opened')
      const start = yield* onlyOpened(seen.opened)
      // The browser goes to the saved server's sign-in, and only the digest and the name go along.
      expect(start.place).toBe(`${origin}${SIGN_IN_PLACES.start}`)
      expect(new Set(new URL(String(seen.opened[0])).searchParams.keys())).toEqual(
        new Set(['challenge', 'state', 'port']),
      )

      const redirect = yield* get(start.granted)
      const ending = yield* signIn.ended
      expect(grantOf(ending)).toEqual(Option.some({ code, state: start.state }))
      // PKCE S256: the challenge the server was shown is the digest of the secret handed over.
      expect(
        Option.map(secretOf(ending), (verifier) =>
          NodeCrypto.createHash('sha256').update(verifier).digest('base64url'),
        ),
      ).toEqual(Option.some(start.challenge))
      expect(seen.focused).toBe(1)
      // An ending is handed over once.
      expect(yield* signIn.ended).toEqual(cancelled)

      // The browser is sent off the address that has the code in it, and told to keep nothing.
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get('location')).toBe('/done')
      expect(redirect.headers.get('cache-control')).toBe('no-store')
      expect(redirect.headers.get('referrer-policy')).toBe('no-referrer')
      expect(redirect.body).toBe('')
      // The same return a second time is not read again.
      expect((yield* get(start.granted)).status).toBe(404)

      const page = yield* get(`${start.loopback}/done`)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(page.headers.get('cache-control')).toBe('no-store')
      expect(page.headers.get('referrer-policy')).toBe('no-referrer')
      expect(page.body).toContain('<h1>You are in.</h1>')
      expect(page.body).toContain('<p>Go back to Vivid. You can close this tab.</p>')
      expect(page.body).toContain('transform:rotate(4deg)')
      expect(page.body).not.toContain(code)
      // Self-contained: no script, and nothing it would have to fetch.
      expect(page.body).not.toMatch(/<script|<link|<img|url\(|@import|https?:/u)
      // The page is served once, and by then nothing is listening.
      expect(yield* Effect.flip(get(`${start.loopback}/done`))).toBeInstanceOf(NothingListening)
    }),
  )

  it.effect('an ending that came before anyone asked is kept, and handed over exactly once', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const granted = yield* onlyOpened(seen.opened)
      // The whole return, page included, is over before the window asks how it ended.
      yield* get(granted.granted)
      yield* get(`${granted.loopback}/done`)
      expect(grantOf(yield* signIn.ended)).toEqual(Option.some({ code, state: granted.state }))
      expect(yield* signIn.ended).toEqual(cancelled)

      yield* signIn.begin
      const failed = yield* startOf(String(seen.opened[1]))
      yield* get(failed.failed)
      expect(yield* signIn.ended).toEqual(SignInEnding.cases.Failed.make({}))
      expect(yield* signIn.ended).toEqual(cancelled)

      yield* signIn.begin
      yield* TestClock.adjust('5 minutes')
      expect(yield* signIn.ended).toEqual(SignInEnding.cases.Expired.make({}))
      expect(yield* signIn.ended).toEqual(cancelled)

      // An ending nobody asked for does not outlive a cancel or another begin.
      yield* signIn.begin
      yield* get((yield* startOf(String(seen.opened[3]))).granted)
      yield* signIn.cancel
      expect(yield* signIn.ended).toEqual(cancelled)
    }),
  )

  it.effect('anything that is not this attempt’s return gets a 404 and the attempt goes on', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const start = yield* onlyOpened(seen.opened)
      const other = SignInReturn.cases.Granted.make({
        code,
        state: SignInAttempt.make('0123456789abcdef'),
      })
      const granted = new URL(start.granted)
      const strays = [
        // Another attempt's name, with a code or with a failure.
        start.back(other),
        start.back(SignInReturn.cases.Failed.make({ state: other.state })),
        // The right query on another path, and the page before any return.
        `${start.loopback}/callback${granted.search}`,
        `${start.loopback}/done`,
        // What a browser and a probe ask for by themselves.
        `${start.loopback}/favicon.ico`,
        `${start.loopback}/`,
        // A code of the wrong shape, and no code at all.
        `${start.loopback}/?state=${start.state}&code=short`,
        `${start.loopback}/?state=${start.state}`,
      ]
      for (const address of strays) {
        const answer = yield* get(address)
        expect(answer.status).toBe(404)
        expect(answer.headers.get('cache-control')).toBe('no-store')
      }
      // Only a GET is a return.
      expect((yield* request(start.granted, 'POST')).status).toBe(404)
      expect(seen.focused).toBe(0)

      // Still in progress: the browser can be sent to the same address again, and the real
      // return still ends it.
      expect(yield* signIn.reopen).toBe('opened')
      expect(seen.opened).toEqual([seen.opened[0], seen.opened[0]])
      yield* get(start.granted)
      expect(SignInEnding.guards.Granted(yield* signIn.ended)).toBe(true)
    }),
  )

  it.effect('a return without a code ends the attempt Failed and says so in the browser', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const start = yield* onlyOpened(seen.opened)
      expect((yield* get(start.failed)).status).toBe(302)
      expect(yield* signIn.ended).toEqual(SignInEnding.cases.Failed.make({}))
      expect(seen.focused).toBe(1)
      const page = yield* get(`${start.loopback}/done`)
      expect(page.body).toContain('<h1>Google sign-in did not finish.</h1>')
      expect(page.body).toContain('<p>Go back to Vivid and try again.</p>')
      // The same face, level: it leans only when the Person is in.
      expect(page.body).toContain('<svg class="face"')
      expect(page.body).toContain('transform:rotate(0deg)')
      expect(yield* Effect.flip(get(start.loopback))).toBeInstanceOf(NothingListening)
    }),
  )

  it.effect('the page is the app’s own page, ink and face, in the browser’s light and dark', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      const surfaces = yield* loadThemeSurfaces(shipped)
      yield* signIn.begin
      const start = yield* onlyOpened(seen.opened)
      yield* get(start.granted)
      const { body } = yield* get(`${start.loopback}/done`)
      const [light, dark] = body.split('@media (prefers-color-scheme:dark)')
      expect(light).toContain(`--page:${surfaces.light};--ink:${surfaces.inkBase.light}`)
      expect(dark).toContain(`--page:${surfaces.dark};--ink:${surfaces.inkBase.dark}`)
      // Vivid's face is on the page, drawn in the page itself and painted in the app's accent for
      // each scheme. The scheme's own block is what sets the fill, so neither borrows the other's.
      expect(light).toContain(`--face:${surfaces.face.light};--eye:${surfaces.face.eye}`)
      expect(dark).toContain(`--face:${surfaces.face.dark}`)
      expect(surfaces.face.dark).not.toBe(surfaces.face.light)
      expect(body).toContain('.face{')
      expect(body).toContain('background:var(--face)')
      expect(body).toContain('fill:var(--eye)')
      // It comes before the heading and is decoration to a screen reader.
      expect(body).toMatch(/<main><svg class="face" aria-hidden="true"[^>]*>.*<\/svg><h1>/u)
      expect(body).toContain('<title>Vivid</title>')
    }),
  )

  it.effect('five minutes without a return ends the attempt Expired and stops listening', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const start = yield* onlyOpened(seen.opened)
      const ended = yield* Effect.forkChild(signIn.ended, { startImmediately: true })
      yield* TestClock.adjust('299 seconds')
      // One second short: still listening, and still nothing to say.
      expect((yield* get(`${start.loopback}/favicon.ico`)).status).toBe(404)
      expect(ended.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 second')
      expect(yield* Fiber.join(ended)).toEqual(SignInEnding.cases.Expired.make({}))
      expect(yield* Effect.flip(get(start.granted))).toBeInstanceOf(NothingListening)
      expect(yield* signIn.reopen).toBe('unopened')
      expect(seen.focused).toBe(0)
    }),
  )

  it.effect('a second begin cancels the first and closes its listener', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const first = yield* startOf(String(seen.opened[0]))
      const ended = yield* Effect.forkChild(signIn.ended, { startImmediately: true })
      expect(yield* signIn.begin).toBe('opened')
      expect(yield* Fiber.join(ended)).toEqual(cancelled)
      expect(yield* Effect.flip(get(first.granted))).toBeInstanceOf(NothingListening)

      const second = yield* startOf(String(seen.opened[1]))
      expect(second.state).not.toBe(first.state)
      expect(second.challenge).not.toBe(first.challenge)
      // The first attempt's name means nothing to the second attempt's listener.
      const stale = SignInReturn.cases.Granted.make({ code, state: first.state })
      expect((yield* get(second.back(stale))).status).toBe(404)
      yield* get(second.granted)
      expect(grantOf(yield* signIn.ended)).toEqual(Option.some({ code, state: second.state }))
    }),
  )

  it.effect('cancel ends the attempt Cancelled and stops listening', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const start = yield* onlyOpened(seen.opened)
      const ended = yield* Effect.forkChild(signIn.ended, { startImmediately: true })
      yield* signIn.cancel
      expect(yield* Fiber.join(ended)).toEqual(cancelled)
      expect(yield* Effect.flip(get(start.granted))).toBeInstanceOf(NothingListening)
      expect(yield* signIn.reopen).toBe('unopened')
      expect(yield* signIn.ended).toEqual(cancelled)
      // Cancelling with nothing in progress is nothing.
      yield* signIn.cancel
    }),
  )

  it.effect('a browser that does not open leaves the attempt waiting, and reopen sends it', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      seen.opens = false
      expect(yield* signIn.begin).toBe('unopened')
      expect(yield* signIn.reopen).toBe('unopened')
      expect(seen.opened).toEqual([])
      seen.opens = true
      expect(yield* signIn.reopen).toBe('opened')
      const start = yield* onlyOpened(seen.opened)
      // The listener was there all along.
      yield* get(start.granted)
      expect(SignInEnding.guards.Granted(yield* signIn.ended)).toBe(true)
    }),
  )

  it.effect('with no server chosen nothing listens and no browser opens', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(ServerSettings.cases.NoServer.make({}))
      expect(yield* signIn.begin).toBe('unopened')
      expect(yield* signIn.reopen).toBe('unopened')
      expect(yield* signIn.ended).toEqual(cancelled)
      expect(seen.opened).toEqual([])
    }),
  )

  it.effect('a browser that never asks for the page does not keep the listener open', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const start = yield* onlyOpened(seen.opened)
      yield* get(start.granted)
      expect(SignInEnding.guards.Granted(yield* signIn.ended)).toBe(true)
      yield* TestClock.adjust('10 seconds')
      expect(yield* Effect.flip(get(`${start.loopback}/done`))).toBeInstanceOf(NothingListening)
    }),
  )

  it.effect('two that wait on one attempt do not both get its code and secret', () =>
    Effect.gen(function* () {
      const { signIn, seen } = yield* fixture(chosen)
      yield* signIn.begin
      const start = yield* onlyOpened(seen.opened)
      const first = yield* Effect.forkChild(signIn.ended)
      const second = yield* Effect.forkChild(signIn.ended)
      yield* get(start.granted)

      const endings = [yield* Fiber.join(first), yield* Fiber.join(second)]
      expect(endings.filter(SignInEnding.guards.Granted)).toHaveLength(1)
      expect(endings.filter(SignInEnding.guards.Cancelled)).toHaveLength(1)
      // And it is gone for anyone who asks afterwards.
      expect(yield* signIn.ended).toEqual(cancelled)
    }),
  )

  it.effect('a window still waiting when the app quits is told the attempt is over', () =>
    Effect.gen(function* () {
      const untilQuit = yield* Scope.make()
      const { signIn } = yield* fixture(chosen).pipe(Scope.provide(untilQuit))
      yield* signIn.begin
      const waiting = yield* Effect.forkChild(signIn.ended)
      yield* Scope.close(untilQuit, Exit.void)
      expect(yield* Fiber.join(waiting)).toEqual(cancelled)
    }),
  )

  it.effect(
    'the listener closes with the scope the sign-in was made in, as when the app quits',
    () =>
      Effect.gen(function* () {
        const untilQuit = yield* Scope.make()
        const { signIn, seen } = yield* fixture(chosen).pipe(Scope.provide(untilQuit))
        yield* signIn.begin
        const start = yield* onlyOpened(seen.opened)
        expect((yield* get(`${start.loopback}/favicon.ico`)).status).toBe(404)
        yield* Scope.close(untilQuit, Exit.void)
        expect(yield* Effect.flip(get(start.granted))).toBeInstanceOf(NothingListening)
      }),
  )
})
