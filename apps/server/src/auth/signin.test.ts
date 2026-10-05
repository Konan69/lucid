import * as NodeCrypto from 'node:crypto'
import { NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import {
  PhoneSignedIn,
  readPhoneSignInReturn,
  SignedIn,
  SignInReturn,
} from '@vivid/contracts/signin'
import { eq } from 'drizzle-orm'
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { afterAll, beforeAll, vi } from 'vitest'
import { GoogleOAuthConfiguration, ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { authRoute } from '../http/router.ts'
import { changesLayer } from '../live/changes.ts'
import { personTable, verificationTable } from './tables.ts'

/**
 * The desktop app's and the phone app's Google sign-in, through the production auth routes over
 * real PostgreSQL (`signin.ts`). Every request is a real one, over a socket, to the route the HTTP router mounts
 * at `/api/auth/*`, and the callback that issues a code is Better Auth's own, run whole.
 *
 * One thing stands in for something real: Google's token endpoint, the single address that
 * callback asks Google anything at (`validateAuthorizationCode` in better-auth 1.7.5's Google
 * provider; the Person's profile is then read out of the ID token it answers with, by
 * `getUserInfo`). `asGoogle` answers that one address and passes every other request through
 * untouched. So what a test calls "choosing an account at Google" is the browser arriving at the
 * callback with a code that names the account, exactly as Google sends it.
 */
const testLayer = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  changesLayer.pipe(Layer.provide(testDatabaseLayer)),
)

const GOOGLE_TOKENS = 'https://oauth2.googleapis.com/token'

/** A Google account, as the ID token names it. */
const Account = Schema.Struct({ sub: Schema.String, email: Schema.String, name: Schema.String })
type Account = typeof Account.Type
const decodeAccount = Schema.decodeUnknownSync(Schema.fromJsonString(Account))

const base64url = (text: string) => Buffer.from(text).toString('base64url')

/** The code Google would send the browser back with for an account. Here it simply names it. */
const codeFor = (account: Account) => base64url(JSON.stringify(account))

/**
 * Google's answer to a code: tokens whose ID token carries the account the code names. The ID
 * token is read for its claims and not for its signature on this path (it arrives from Google
 * over the connection the server opened), so the signature is filler.
 */
const tokensFor = (code: string) => {
  const claims = {
    ...decodeAccount(Buffer.from(code, 'base64url').toString()),
    email_verified: true,
  }
  const idToken = [{ alg: 'RS256', typ: 'JWT' }, claims]
    .map((part) => base64url(JSON.stringify(part)))
    .concat('signature')
    .join('.')
  return Response.json({
    access_token: 'test-access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'openid email profile',
    id_token: idToken,
  })
}

/** `fetch`, with Google's token endpoint answered here and everything else left alone. */
const asGoogle =
  (real: typeof fetch): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init)
    if (request.url !== GOOGLE_TOKENS) return real(input, init)
    return request.text().then((form) => tokensFor(String(new URLSearchParams(form).get('code'))))
  }

/** A served copy of the auth routes, and the public origin its Better Auth was built for. */
interface Server {
  readonly client: HttpClient.HttpClient
  readonly origin: string
}

/**
 * Serves the route the server mounts at `/api/auth/*` on a real Node socket, as a server whose
 * public address is `origin`. Google is set up with a client that does not exist: nothing here
 * reaches Google.
 */
const served = Effect.fn('SignInTest.served')(function* (origin: string, google: boolean) {
  const config = yield* ServerConfig
  const server = yield* Layer.build(NodeHttpServer.layerTest)
  yield* Layer.build(HttpRouter.serve(authRoute, { disableLogger: true })).pipe(
    Effect.provide(server),
    Effect.provideService(ServerConfig, {
      ...config,
      PUBLIC_URL: new URL(origin),
      GOOGLE_OAUTH: google
        ? GoogleOAuthConfiguration.Enabled({
            clientId: 'desktop-sign-in-test.apps.googleusercontent.com',
            clientSecret: Redacted.make('test-Google_secret-0123456789'),
            redirectUri: new URL(`${origin}/api/auth/callback/google`),
          })
        : GoogleOAuthConfiguration.Disabled(),
    }),
  )
  return { client: Context.get(server, HttpClient.HttpClient), origin } satisfies Server
})

/** The server as the test configuration builds it: plain `http` on the loopback address. */
const local = served('http://127.0.0.1:8787', true)
/** The same server at a public `https` address, as production is. */
const secure = served('https://vivid.example', true)

/** What one test request is made of. Only a request that sends something has a body. */
interface Sent {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

type Answer = HttpClientResponse.HttpClientResponse

/**
 * One request to the served auth routes, over the socket. A redirect is the answer and is not
 * followed: these routes answer with one, and following it would leave the test. The test
 * server's client is `fetch` (`NodeHttpServer.layerTest`), which reads its options from
 * `FetchHttpClient.RequestInit` when the request is made.
 */
const call = (server: Server, path: string, sent: Sent) => {
  const request = HttpClientRequest.make(sent.method)(`/api/auth/${path}`).pipe(
    HttpClientRequest.setHeaders(sent.headers),
  )
  return server.client
    .execute(
      sent.body === undefined
        ? request
        : HttpClientRequest.bodyText(request, sent.body, 'application/json'),
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { keepalive: false, redirect: 'manual' }),
    )
}

/** The cookies a response set, as the `cookie` header a browser would send back. */
const cookiesOf = (response: Answer) =>
  Object.values(response.cookies.cookies)
    .map((entry) => `${entry.name}=${entry.valueEncoded}`)
    .join('; ')

/** The session cookie a response set, when it set one that holds a session. */
const sessionCookieOf = (response: Answer) =>
  Object.values(response.cookies.cookies).find(
    (entry) => entry.name.endsWith('session_token') && entry.value !== '',
  )

/** Where a redirect sends the browser. A response that is not a redirect fails the test. */
const sentTo = (server: Server, response: Answer) => {
  expect(response.status).toBe(302)
  const location = response.headers['location']
  if (location === undefined) return expect.fail('The redirect names no address')
  return new URL(location, server.origin)
}

/** A response body decoded with the schema the test reads it by. */
const bodyOf = <Value, Encoded>(response: Answer, schema: Schema.Codec<Value, Encoded>) =>
  response.text.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))))

const Here = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ email: Schema.String }),
})
const Started = Schema.Struct({ url: Schema.String })

/** Who a cookie is signed in as, and in which session. */
const whoIs = (server: Server, cookie: string) =>
  call(server, 'get-session', { method: 'GET', headers: { origin: server.origin, cookie } }).pipe(
    Effect.flatMap((response) => bodyOf(response, Here)),
  )

/** What an app holds for one attempt: its secret, the digest it sends, its name, its port. */
const attempt = () => {
  const verifier = NodeCrypto.randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: NodeCrypto.createHash('sha256').update(verifier).digest('base64url'),
    state: NodeCrypto.randomBytes(12).toString('hex').slice(0, 16),
    port: 49_321,
  }
}
type Attempt = ReturnType<typeof attempt>

/** The address the desktop shell opens in the system browser. */
const startOf = (mine: Attempt) =>
  `desktop/google?${new URLSearchParams({
    challenge: mine.challenge,
    state: mine.state,
    port: String(mine.port),
  }).toString()}`

/**
 * A Google account no test has used, whose Person is removed again when the test's scope closes.
 * The removal is registered here, before anything can have signed the account in.
 */
const account = Effect.fn('SignInTest.account')(function* () {
  const database = yield* Database
  const sub = NodeCrypto.randomUUID()
  const email = `${sub}@example.test`
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.email, email))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Desktop sign-in fixture cleanup failed'))),
    ),
  )
  return { sub, email, name: 'Desktop test' } satisfies Account
})

/** The browser at Google for one attempt: where it was sent, and the cookies it was given. */
const begun = Effect.fn('SignInTest.begun')(function* (server: Server, mine: Attempt) {
  const response = yield* call(server, startOf(mine), { method: 'GET', headers: {} })
  const google = sentTo(server, response)
  return { google, cookie: cookiesOf(response) }
})

/**
 * The browser coming back from Google to Better Auth's callback, with whatever Google put on the
 * address (`code` for an account that was chosen, `error` when it was not) and the cookies the
 * browser holds.
 */
const cameBack = (
  server: Server,
  round: { readonly google: URL; readonly cookie: string },
  fromGoogle: Readonly<Record<string, string>>,
) =>
  call(
    server,
    `callback/google?${new URLSearchParams({
      ...fromGoogle,
      state: String(round.google.searchParams.get('state')),
    }).toString()}`,
    { method: 'GET', headers: { cookie: round.cookie } },
  )

/** An attempt carried as far as the code arriving at the app, for an account chosen at Google. */
const granted = Effect.fn('SignInTest.granted')(function* (server: Server, who: Account) {
  const mine = attempt()
  const round = yield* begun(server, mine)
  const callback = yield* cameBack(server, round, { code: codeFor(who) })
  const app = sentTo(server, callback)
  const code = app.searchParams.get('code')
  if (code === null) return expect.fail('The app was sent no code')
  return { mine, app, code, browser: cookiesOf(callback) }
})

/** The address the phone app opens in the browser. */
const startOnPhone = (mine: Attempt) =>
  `phone/google?${new URLSearchParams({ challenge: mine.challenge, state: mine.state }).toString()}`

/**
 * What the browser hands the phone app: the link a redirect names, read the way the app
 * reads it (`readPhoneSignInReturn`). A response that is not a redirect to the app's own link
 * fails the test.
 */
const handedBack = (response: Answer) => {
  expect(response.status).toBe(302)
  const link = response.headers['location']
  if (link === undefined) return expect.fail('The redirect names no link')
  return Option.match(readPhoneSignInReturn(link), {
    onNone: () => expect.fail(`The browser was not sent to the phone app's link: ${link}`),
    onSome: (back) => back,
  })
}

/** The browser at Google for one phone attempt, then back at the callback with what Google sent. */
const roundOnPhone = Effect.fn('SignInTest.roundOnPhone')(function* (
  server: Server,
  held: string,
  fromGoogle: Readonly<Record<string, string>>,
) {
  const mine = attempt()
  const response = yield* call(server, startOnPhone(mine), { method: 'GET', headers: {} })
  const google = sentTo(server, response)
  const cookie = [cookiesOf(response), held].filter((part) => part !== '').join('; ')
  const callback = yield* cameBack(server, { google, cookie }, fromGoogle)
  return { mine, google, callback, back: handedBack(callback) }
})

/** A phone attempt carried as far as the code arriving at the app, for an account chosen at Google. */
const grantedOnPhone = Effect.fn('SignInTest.grantedOnPhone')(function* (
  server: Server,
  who: Account,
) {
  const { mine, back, callback } = yield* roundOnPhone(server, '', { code: codeFor(who) })
  if (!SignInReturn.guards.Granted(back)) return expect.fail('The phone app was sent no code')
  return { mine, code: back.code, state: back.state, browser: cookiesOf(callback) }
})

/** The trade the phone app makes: no page, so no origin, and no cookie. */
const tradeOnPhone = (server: Server, fields: Traded) =>
  call(server, 'phone/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  })

/** Who a bearer token is signed in as, and in which session. */
const whoHolds = (server: Server, token: Redacted.Redacted) =>
  call(server, 'get-session', {
    method: 'GET',
    headers: { authorization: `Bearer ${Redacted.value(token)}` },
  }).pipe(Effect.flatMap((response) => bodyOf(response, Here)))

interface Traded {
  readonly code: string
  readonly state: string
  readonly verifier: string
}

/** A trade as it goes over the wire, with the headers given beside its content type. */
const posted = (server: Server, headers: Readonly<Record<string, string>>, fields: Traded) =>
  call(server, 'desktop/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(fields),
  })

/** The trade the app's window makes, as a page on `origin`. */
const trade = (server: Server, origin: string, fields: Traded) => posted(server, { origin }, fields)

describe.skipIf(!testDatabaseConfigured)('the desktop app signing in with Google', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', asGoogle(globalThis.fetch))
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  layer(testLayer)((it) => {
    it.effect('sends the browser to Google, to come back to Better Auth’s own callback', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { google } = yield* begun(server, attempt())

        expect(google.origin).toBe('https://accounts.google.com')
        expect(google.searchParams.get('redirect_uri')).toBe(
          `${server.origin}/api/auth/callback/google`,
        )
        // The Person chooses the account every time; a browser is never passed through silently.
        expect(google.searchParams.get('prompt')).toBe('select_account')
      }).pipe(Effect.scoped),
    )

    it.effect('gives the app a session of its own for the account chosen at Google', () =>
      Effect.gen(function* () {
        const server = yield* local
        const who = yield* account()
        const { mine, app, code, browser } = yield* granted(server, who)

        // The browser is sent to the loopback address the app listens on, and nowhere else.
        expect(app.origin).toBe(`http://127.0.0.1:${mine.port}`)
        expect(app.searchParams.get('state')).toBe(mine.state)

        const answer = yield* trade(server, server.origin, {
          code,
          state: mine.state,
          verifier: mine.verifier,
        })
        expect(answer.status).toBe(200)
        // Google made this account a moment ago, and the window is told so.
        expect((yield* bodyOf(answer, SignedIn)).arrival).toBe('first')

        const window = yield* whoIs(server, cookiesOf(answer))
        const inBrowser = yield* whoIs(server, browser)
        // The same Person, in a session that is not the browser's: signing out of one leaves
        // the other signed in.
        expect(window.user.email).toBe(who.email)
        expect(inBrowser.user.email).toBe(who.email)
        expect(window.session.id).not.toBe(inBrowser.session.id)
      }).pipe(Effect.scoped),
    )

    it.effect('tells the window when the account was already there', () =>
      Effect.gen(function* () {
        const server = yield* local
        const who = yield* account()
        yield* granted(server, who)
        const { mine, code } = yield* granted(server, who)

        const answer = yield* trade(server, server.origin, {
          code,
          state: mine.state,
          verifier: mine.verifier,
        })
        expect((yield* bodyOf(answer, SignedIn)).arrival).toBe('returning')
      }).pipe(Effect.scoped),
    )

    it.effect('signs the app in as the account chosen, not the one the browser held', () =>
      Effect.gen(function* () {
        const server = yield* local
        const held = yield* account()
        const chosen = yield* account()
        // The browser is already signed in as one account when the attempt starts.
        const before = yield* granted(server, held)
        const mine = attempt()
        const round = yield* begun(server, mine)
        const callback = yield* cameBack(
          server,
          { google: round.google, cookie: `${round.cookie}; ${before.browser}` },
          { code: codeFor(chosen) },
        )
        const app = sentTo(server, callback)

        const answer = yield* trade(server, server.origin, {
          code: String(app.searchParams.get('code')),
          state: mine.state,
          verifier: mine.verifier,
        })
        expect((yield* whoIs(server, cookiesOf(answer))).user.email).toBe(chosen.email)
      }).pipe(Effect.scoped),
    )

    it.effect('honours a code once, also when it is traded twice at the same moment', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { mine, code } = yield* granted(server, yield* account())
        const fields = { code, state: mine.state, verifier: mine.verifier }

        const both = yield* Effect.all(
          [trade(server, server.origin, fields), trade(server, server.origin, fields)],
          { concurrency: 2 },
        )
        expect(both.map((answer) => answer.status).toSorted((a, b) => a - b)).toEqual([200, 401])
        const later = yield* trade(server, server.origin, fields)
        expect(later.status).toBe(401)
        expect(sessionCookieOf(later)).toBeUndefined()
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a code without the secret its attempt was started with', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { mine, code } = yield* granted(server, yield* account())

        const stolen = yield* trade(server, server.origin, {
          code,
          state: mine.state,
          verifier: attempt().verifier,
        })
        expect(stolen.status).toBe(401)
        expect(sessionCookieOf(stolen)).toBeUndefined()
        // The failed try spent the code, so the secret arriving later does not work either.
        const late = yield* trade(server, server.origin, {
          code,
          state: mine.state,
          verifier: mine.verifier,
        })
        expect(late.status).toBe(401)
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a code traded under another attempt', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { mine, code } = yield* granted(server, yield* account())

        const answer = yield* trade(server, server.origin, {
          code,
          state: attempt().state,
          verifier: mine.verifier,
        })
        expect(answer.status).toBe(401)
        expect(sessionCookieOf(answer)).toBeUndefined()
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a code that has run out', () =>
      Effect.gen(function* () {
        const server = yield* local
        const database = yield* Database
        const { mine, code } = yield* granted(server, yield* account())
        // Five minutes pass for this one code: its record is dated into the past, which is all
        // that time passing would change.
        yield* database.run(
          database
            .update(verificationTable)
            .set({ expiresAt: new Date(0) })
            .where(eq(verificationTable.identifier, `desktop-grant:${code}`)),
        )

        const answer = yield* trade(server, server.origin, {
          code,
          state: mine.state,
          verifier: mine.verifier,
        })
        expect(answer.status).toBe(401)
        expect(sessionCookieOf(answer)).toBeUndefined()
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a trade that is not from the server’s own page, and keeps the code', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { mine, code } = yield* granted(server, yield* account())
        const fields = { code, state: mine.state, verifier: mine.verifier }

        const elsewhere = yield* Effect.forEach(
          ['https://elsewhere.example', `${server.origin}.elsewhere.example`, 'null'],
          (origin) => trade(server, origin, fields),
        )
        // A request that names no origin at all is not the app's page either.
        const unnamed = yield* posted(server, {}, fields)
        for (const answer of [...elsewhere, unnamed]) {
          expect(answer.status).toBe(403)
          expect(sessionCookieOf(answer)).toBeUndefined()
        }
        expect((yield* trade(server, server.origin, fields)).status).toBe(200)
      }).pipe(Effect.scoped),
    )

    it.effect('tells the app when Google did not sign the Person in', () =>
      Effect.gen(function* () {
        const server = yield* local
        const mine = attempt()
        const round = yield* begun(server, mine)

        // What Google sends when the Person closes its page.
        const app = sentTo(server, yield* cameBack(server, round, { error: 'access_denied' }))
        expect(app.origin).toBe(`http://127.0.0.1:${mine.port}`)
        expect(app.searchParams.get('state')).toBe(mine.state)
        expect(app.searchParams.has('error')).toBe(true)
        expect(app.searchParams.has('code')).toBe(false)
      }).pipe(Effect.scoped),
    )

    it.effect('issues no code to a signed-in browser that did not come from Google', () =>
      Effect.gen(function* () {
        const server = yield* local
        // A browser signed in as someone, and a program that started an attempt of its own and
        // sends that browser to the callback with nothing from Google.
        const { browser } = yield* granted(server, yield* account())
        const mine = attempt()
        const round = yield* begun(server, mine)
        const callback = yield* cameBack(
          server,
          { google: round.google, cookie: `${round.cookie}; ${browser}` },
          {},
        )

        const app = sentTo(server, callback)
        expect(app.searchParams.has('code')).toBe(false)
        expect(app.searchParams.has('error')).toBe(true)
        // Nothing the callback answered with can be turned into a code afterwards: the only
        // address it names is the app's own, and there is no route that hands one out.
        expect(app.origin).toBe(`http://127.0.0.1:${mine.port}`)
        const asked = yield* call(server, 'desktop/return', {
          method: 'GET',
          headers: { cookie: browser },
        })
        expect(asked.status).toBe(404)
      }).pipe(Effect.scoped),
    )

    it.effect('leaves a Google sign-in started in a browser tab going where it was going', () =>
      Effect.gen(function* () {
        const server = yield* local
        const who = yield* account()
        const response = yield* call(server, 'sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: server.origin },
          body: JSON.stringify({ provider: 'google', callbackURL: '/somewhere' }),
        })
        const google = new URL((yield* bodyOf(response, Started)).url)

        const callback = yield* cameBack(
          server,
          { google, cookie: cookiesOf(response) },
          { code: codeFor(who) },
        )
        const landing = sentTo(server, callback)
        expect(landing.origin).toBe(server.origin)
        expect(landing.pathname).toBe('/somewhere')
        expect(landing.searchParams.has('code')).toBe(false)
      }).pipe(Effect.scoped),
    )

    it.effect('sets the window a cookie that is signed and out of reach of scripts', () =>
      Effect.gen(function* () {
        const server = yield* secure
        const { mine, code } = yield* granted(server, yield* account())

        const answer = yield* trade(server, server.origin, {
          code,
          state: mine.state,
          verifier: mine.verifier,
        })
        expect(answer.status).toBe(200)
        // On a public https address Better Auth names and marks the cookie as a secure one.
        const cookie = answer.cookies.cookies['__Secure-better-auth.session_token']
        if (cookie === undefined) return expect.fail('The secure session cookie must be set')
        expect(cookie.options).toMatchObject({
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        })
        // Signed: a token, a dot, and the signature Better Auth made with its own secret.
        expect(cookie.value).toMatch(/^[^.]+\..+$/u)
        return undefined
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a start that names a reserved port or a malformed digest', () =>
      Effect.gen(function* () {
        const server = yield* local
        const mine = attempt()

        const reserved = yield* call(server, startOf({ ...mine, port: 443 }), {
          method: 'GET',
          headers: {},
        })
        expect(reserved.status).toBe(400)
        const malformed = yield* call(server, startOf({ ...mine, challenge: 'short' }), {
          method: 'GET',
          headers: {},
        })
        expect(malformed.status).toBe(400)
      }).pipe(Effect.scoped),
    )

    it.effect('has no sign-in to start on a server without Google', () =>
      Effect.gen(function* () {
        const server = yield* served('http://127.0.0.1:8787', false)
        const response = yield* call(server, startOf(attempt()), { method: 'GET', headers: {} })
        expect(response.status).toBe(404)
      }).pipe(Effect.scoped),
    )

    it.effect('issues no code for a Person to read or type, to any app', () =>
      Effect.gen(function* () {
        const server = yield* local
        // The device authorization grant is gone: its routes are not there to be asked.
        for (const path of ['device/code', 'device/token', 'device/approve']) {
          const answer = yield* call(server, path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: server.origin },
            body: JSON.stringify({ client_id: 'vivid-mobile' }),
          })
          expect(answer.status).toBe(404)
        }
      }).pipe(Effect.scoped),
    )
  })
})

describe.skipIf(!testDatabaseConfigured)('the phone app signing in with Google', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', asGoogle(globalThis.fetch))
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  layer(testLayer)((it) => {
    it.effect('sends the browser to Google, where the Person chooses the account', () =>
      Effect.gen(function* () {
        const server = yield* local
        const response = yield* call(server, startOnPhone(attempt()), {
          method: 'GET',
          headers: {},
        })
        const google = sentTo(server, response)

        expect(google.origin).toBe('https://accounts.google.com')
        expect(google.searchParams.get('redirect_uri')).toBe(
          `${server.origin}/api/auth/callback/google`,
        )
        expect(google.searchParams.get('prompt')).toBe('select_account')
      }).pipe(Effect.scoped),
    )

    it.effect('gives the phone a token of its own for the account chosen at Google', () =>
      Effect.gen(function* () {
        const server = yield* local
        const who = yield* account()
        const { mine, code, state, browser } = yield* grantedOnPhone(server, who)
        // The link names the attempt the app started, so the app answers only its own.
        expect(state).toBe(mine.state)

        const answer = yield* tradeOnPhone(server, {
          code,
          state: mine.state,
          verifier: mine.verifier,
        })
        expect(answer.status).toBe(200)
        // The phone keeps a token. Nothing is left as a cookie for a browser to hold.
        expect(sessionCookieOf(answer)).toBeUndefined()
        const { token } = yield* bodyOf(answer, PhoneSignedIn)

        const onPhone = yield* whoHolds(server, token)
        const inBrowser = yield* whoIs(server, browser)
        // The same Person, in a session that is not the browser's: signing out of one leaves the
        // other signed in.
        expect(onPhone.user.email).toBe(who.email)
        expect(inBrowser.user.email).toBe(who.email)
        expect(onPhone.session.id).not.toBe(inBrowser.session.id)
      }).pipe(Effect.scoped),
    )

    it.effect('signs the phone in as the account chosen, not the one the browser held', () =>
      Effect.gen(function* () {
        const server = yield* local
        const held = yield* account()
        const chosen = yield* account()
        const before = yield* grantedOnPhone(server, held)
        const { mine, back } = yield* roundOnPhone(server, before.browser, {
          code: codeFor(chosen),
        })
        if (!SignInReturn.guards.Granted(back)) return expect.fail('The phone app was sent no code')

        const answer = yield* tradeOnPhone(server, {
          code: back.code,
          state: mine.state,
          verifier: mine.verifier,
        })
        const { token } = yield* bodyOf(answer, PhoneSignedIn)
        expect((yield* whoHolds(server, token)).user.email).toBe(chosen.email)
        return undefined
      }).pipe(Effect.scoped),
    )

    it.effect('issues no code to a signed-in browser that did not come from Google', () =>
      Effect.gen(function* () {
        const server = yield* local
        // A browser signed in as someone, and a program that started a phone attempt of its own
        // and sends that browser to the callback with nothing from Google.
        const { browser } = yield* grantedOnPhone(server, yield* account())
        const { mine, back } = yield* roundOnPhone(server, browser, {})

        expect(back).toEqual(SignInReturn.cases.Failed.make({ state: mine.state }))
      }).pipe(Effect.scoped),
    )

    it.effect('tells the phone when Google did not sign the Person in', () =>
      Effect.gen(function* () {
        const server = yield* local
        // What Google sends when the Person closes its page.
        const { mine, back } = yield* roundOnPhone(server, '', { error: 'access_denied' })

        expect(back).toEqual(SignInReturn.cases.Failed.make({ state: mine.state }))
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a code without the secret its attempt was started with', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { mine, code } = yield* grantedOnPhone(server, yield* account())
        // Whoever read the code off the link does not have the secret, and the try spends it.
        const stolen = yield* tradeOnPhone(server, {
          code,
          state: mine.state,
          verifier: attempt().verifier,
        })
        expect(stolen.status).toBe(401)
        const late = yield* tradeOnPhone(server, {
          code,
          state: mine.state,
          verifier: mine.verifier,
        })
        expect(late.status).toBe(401)
      }).pipe(Effect.scoped),
    )

    it.effect('honours a code once, also when it is traded twice at the same moment', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { mine, code } = yield* grantedOnPhone(server, yield* account())
        const fields = { code, state: mine.state, verifier: mine.verifier }

        const both = yield* Effect.all(
          [tradeOnPhone(server, fields), tradeOnPhone(server, fields)],
          { concurrency: 2 },
        )
        expect(both.map((answer) => answer.status).toSorted((a, b) => a - b)).toEqual([200, 401])
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a code traded under another attempt', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { mine, code } = yield* grantedOnPhone(server, yield* account())

        const answer = yield* tradeOnPhone(server, {
          code,
          state: attempt().state,
          verifier: mine.verifier,
        })
        expect(answer.status).toBe(401)
      }).pipe(Effect.scoped),
    )

    it.effect('keeps each app’s code to that app’s own trade', () =>
      Effect.gen(function* () {
        const server = yield* local
        const who = yield* account()
        // A desktop code would sign a phone in without the origin check the window's trade
        // makes, and a phone code would set a cookie; neither is found at the other's trade.
        const desktop = yield* granted(server, who)
        const atPhone = yield* tradeOnPhone(server, {
          code: desktop.code,
          state: desktop.mine.state,
          verifier: desktop.mine.verifier,
        })
        expect(atPhone.status).toBe(401)

        const phone = yield* grantedOnPhone(server, who)
        const atWindow = yield* trade(server, server.origin, {
          code: phone.code,
          state: phone.mine.state,
          verifier: phone.mine.verifier,
        })
        expect(atWindow.status).toBe(401)
        expect(sessionCookieOf(atWindow)).toBeUndefined()
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a start with a malformed digest, and has none without Google', () =>
      Effect.gen(function* () {
        const server = yield* local
        const malformed = yield* call(server, startOnPhone({ ...attempt(), challenge: 'short' }), {
          method: 'GET',
          headers: {},
        })
        expect(malformed.status).toBe(400)

        const without = yield* served('http://127.0.0.1:8787', false)
        const response = yield* call(without, startOnPhone(attempt()), {
          method: 'GET',
          headers: {},
        })
        expect(response.status).toBe(404)
      }).pipe(Effect.scoped),
    )
  })
})
