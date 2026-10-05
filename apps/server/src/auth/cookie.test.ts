import * as NodeCrypto from 'node:crypto'
import { NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import { authRoute } from '../http/router.ts'
import { personTable } from './tables.ts'

/**
 * The desktop window's way in, end to end through the production auth routes over real
 * PostgreSQL: a device-code exchange approved by a signed-in browser, then the trade of the
 * exchange's bearer token for a session cookie (`cookie.ts`). Nothing is mocked; the cookie under
 * test is the one Better Auth itself signs. Each request is a real one, over a socket, to the
 * route the HTTP router mounts at `/api/auth/*`, so what is asserted is what goes out on the wire.
 */
const testLayer = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  changesLayer.pipe(Layer.provide(testDatabaseLayer)),
)

const CLIENT = 'vivid-desktop'

/** A served copy of the auth routes, and the public origin its Better Auth was built for. */
interface Server {
  readonly client: HttpClient.HttpClient
  readonly origin: string
}

/**
 * Serves the route the server mounts at `/api/auth/*` (`authRoute`) on a real Node socket and
 * hands back a client for it. Real requests matter here: the route decides from the headers Node
 * frames a request with, which a hand-built request object would not have.
 */
const served = Effect.fn('CookieTest.served')(function* (origin: string) {
  const config = yield* ServerConfig
  const server = yield* Layer.build(NodeHttpServer.layerTest)
  yield* Layer.build(HttpRouter.serve(authRoute, { disableLogger: true })).pipe(
    Effect.provide(server),
    Effect.provideService(ServerConfig, { ...config, PUBLIC_URL: new URL(origin) }),
  )
  return { client: Context.get(server, HttpClient.HttpClient), origin } satisfies Server
})

/** The server as the test configuration builds it: plain `http` on the loopback address. */
const local = served('http://127.0.0.1:8787')

/**
 * The same server built for a public `https` address, as production is. Better Auth then names
 * and marks its cookies as secure ones, which is the only thing these tests use it for.
 */
const secure = served('https://vivid.example')

const json = (server: Server) => ({ 'content-type': 'application/json', origin: server.origin })
const bearer = (token: Redacted.Redacted) => `Bearer ${Redacted.value(token)}`

/** What one test request is made of. Only a request that sends something has a body. */
interface Sent {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** One request to the served auth routes, over the socket. */
const call = (server: Server, path: string, sent: Sent) => {
  const request = HttpClientRequest.make(sent.method)(`/api/auth/${path}`).pipe(
    HttpClientRequest.setHeaders(sent.headers),
  )
  return server.client.execute(
    sent.body === undefined
      ? request
      : HttpClientRequest.bodyText(request, sent.body, 'application/json'),
  )
}

type Answer = HttpClientResponse.HttpClientResponse

/** The cookies a response set, as the `cookie` header a browser would send back. */
const cookiesOf = (response: Answer) =>
  Object.values(response.cookies.cookies)
    .map((entry) => `${entry.name}=${entry.valueEncoded}`)
    .join('; ')

/**
 * Whether a response set a session cookie that holds a session. A refusal still names the cookie,
 * to expire it with an empty value, so the name alone proves nothing.
 */
const setsSession = (response: Answer) =>
  Object.values(response.cookies.cookies).some(
    (entry) => entry.name.endsWith('session_token') && entry.value !== '',
  )

/** A response body decoded with the schema the test reads it by. */
const bodyOf = <Value, Encoded>(response: Answer, schema: Schema.Codec<Value, Encoded>) =>
  response.text.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))))

const Code = Schema.Struct({ device_code: Schema.String, user_code: Schema.String })
const Claimed = Schema.Struct({ client_id: Schema.String })
const Grant = Schema.Struct({ access_token: Schema.RedactedFromValue(Schema.String) })
const Here = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ email: Schema.String }),
})

/** A Person signed up through the production route, removed again when the test's scope closes. */
const signedUp = Effect.fn('CookieTest.signedUp')(function* (server: Server) {
  const database = yield* Database
  const email = `${NodeCrypto.randomUUID()}@example.test`
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.email, email))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Cookie fixture cleanup failed'))),
    ),
  )
  const response = yield* call(server, 'sign-up/email', {
    method: 'POST',
    headers: json(server),
    body: JSON.stringify({ email, name: 'Cookie test', password: 'test-Cookie-0123456789' }),
  })
  expect(response.status).toBe(200)
  return { email, cookie: cookiesOf(response) }
})

/**
 * The whole exchange a desktop window runs, with `browser` standing for the system browser that
 * is already signed in: a code is issued, the browser claims and approves it, and the window's
 * next token request is answered with a session token.
 */
const exchanged = Effect.fn('CookieTest.exchanged')(function* (server: Server, browser: string) {
  const issued = yield* call(server, 'device/code', {
    method: 'POST',
    headers: json(server),
    body: JSON.stringify({ client_id: CLIENT }),
  })
  const code = yield* bodyOf(issued, Code)
  const claimed = yield* call(server, `device?user_code=${encodeURIComponent(code.user_code)}`, {
    method: 'GET',
    headers: { origin: server.origin, cookie: browser },
  })
  expect(claimed.status).toBe(200)
  // The Person approving is told which app asked, which is what the approval page words.
  expect((yield* bodyOf(claimed, Claimed)).client_id).toBe(CLIENT)
  const approved = yield* call(server, 'device/approve', {
    method: 'POST',
    headers: { ...json(server), cookie: browser },
    body: JSON.stringify({ userCode: code.user_code }),
  })
  expect(approved.status).toBe(200)
  const granted = yield* call(server, 'device/token', {
    method: 'POST',
    headers: json(server),
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: CLIENT,
    }),
  })
  expect(granted.status).toBe(200)
  // The exchange itself sets no cookie, which is the gap the route under test fills.
  expect(setsSession(granted)).toBe(false)
  return (yield* bodyOf(granted, Grant)).access_token
})

/** A window holding the token of a session it signed in with a code, and the Person it is. */
const windowWithToken = Effect.fn('CookieTest.windowWithToken')(function* (server: Server) {
  const person = yield* signedUp(server)
  return { person, token: yield* exchanged(server, person.cookie) }
})

describe.skipIf(!testDatabaseConfigured)('trading a session token for its cookie', () => {
  layer(testLayer)((it) => {
    it.effect('gives a window that signed in with a code a cookie for that same session', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { person, token } = yield* windowWithToken(server)

        const adopted = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: server.origin, authorization: bearer(token) },
        })
        expect(adopted.status).toBe(204)
        expect(setsSession(adopted)).toBe(true)
        const cookie = cookiesOf(adopted)

        // The cookie alone, with no bearer, is now the window's session: the same Person, and
        // the session the exchange made, not a second one.
        const byCookie = yield* bodyOf(
          yield* call(server, 'get-session', {
            method: 'GET',
            headers: { origin: server.origin, cookie },
          }),
          Here,
        )
        const byToken = yield* bodyOf(
          yield* call(server, 'get-session', {
            method: 'GET',
            headers: { origin: server.origin, authorization: bearer(token) },
          }),
          Here,
        )
        expect(byCookie.user.email).toBe(person.email)
        expect(byCookie.session.id).toBe(byToken.session.id)
      }).pipe(Effect.scoped),
    )

    it.effect('sets the cookie Better Auth names, signed, and out of reach of scripts', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { token } = yield* windowWithToken(server)
        const adopted = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: server.origin, authorization: bearer(token) },
        })
        const cookie = adopted.cookies.cookies['better-auth.session_token']
        if (cookie === undefined) return expect.fail('The session cookie must be set')
        // Signed: the token, a dot, and the signature Better Auth made with its own secret. The
        // value is never the bare token.
        expect(cookie.value.startsWith(`${Redacted.value(token)}.`)).toBe(true)
        expect(cookie.value.length).toBeGreaterThan(Redacted.value(token).length + 1)
        expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' })
        // Plain http on the loopback address: a Secure cookie would never be sent back.
        expect(cookie.options).not.toMatchObject({ secure: true })
        return undefined
      }).pipe(Effect.scoped),
    )

    it.effect('marks the cookie Secure when the server is public over https', () =>
      Effect.gen(function* () {
        const server = yield* secure
        const { token } = yield* windowWithToken(server)
        const adopted = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: server.origin, authorization: bearer(token) },
        })
        expect(adopted.status).toBe(204)
        const cookie = adopted.cookies.cookies['__Secure-better-auth.session_token']
        if (cookie === undefined) return expect.fail('The secure session cookie must be set')
        expect(cookie.options).toMatchObject({
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        })
        return undefined
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a request that is not from the server’s own origin', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { token } = yield* windowWithToken(server)
        const authorization = bearer(token)
        const foreign = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: 'https://elsewhere.example', authorization },
        })
        const lookalike = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: 'http://127.0.0.1:8788', authorization },
        })
        const unnamed = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { authorization },
        })
        for (const response of [foreign, lookalike, unnamed]) {
          expect(response.status).toBe(403)
          expect(setsSession(response)).toBe(false)
        }
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a caller with no bearer, a cookie alone included', () =>
      Effect.gen(function* () {
        const server = yield* local
        const person = yield* signedUp(server)
        const nobody = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: server.origin },
        })
        // Signed in by cookie, with nothing to trade: this route is only for trading a bearer.
        const cookieOnly = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: server.origin, cookie: person.cookie },
        })
        const forged = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { origin: server.origin, authorization: `Bearer ${NodeCrypto.randomUUID()}` },
        })
        for (const response of [nobody, cookieOnly, forged]) {
          expect(response.status).toBe(401)
          expect(setsSession(response)).toBe(false)
        }
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a request with a body, and any method but POST', () =>
      Effect.gen(function* () {
        const server = yield* local
        const { token } = yield* windowWithToken(server)
        const withBody = yield* call(server, 'adopt-session', {
          method: 'POST',
          headers: { ...json(server), authorization: bearer(token) },
          body: JSON.stringify({ callbackURL: 'https://elsewhere.example' }),
        })
        expect(withBody.status).toBe(400)
        expect(setsSession(withBody)).toBe(false)
        const got = yield* call(server, 'adopt-session', {
          method: 'GET',
          headers: { origin: server.origin, authorization: bearer(token) },
        })
        expect(got.status).toBe(404)
        expect(setsSession(got)).toBe(false)
      }).pipe(Effect.scoped),
    )
  })
})

describe.skipIf(!testDatabaseConfigured)('which apps may sign in with a code', () => {
  layer(testLayer)((it) => {
    it.effect('issues a code to Vivid’s own apps and to no other name', () =>
      Effect.gen(function* () {
        const server = yield* local
        const ask = (client: string) =>
          call(server, 'device/code', {
            method: 'POST',
            headers: json(server),
            body: JSON.stringify({ client_id: client }),
          })
        for (const client of ['vivid-desktop', 'vivid-mobile'])
          expect((yield* ask(client)).status).toBe(200)
        for (const client of ['someone-else', 'vivid-desktop ', 'Vivid-Desktop', '']) {
          const refused = yield* ask(client)
          expect(refused.status).toBe(400)
        }
        const said = yield* bodyOf(
          yield* ask('someone-else'),
          Schema.Struct({ error: Schema.String }),
        )
        expect(said.error).toBe('invalid_client')
      }).pipe(Effect.scoped),
    )
  })
})
