import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Redacted, Schema } from 'effect'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import { authEffect, localAuthRuntimeLayer, type AuthInstance } from './provider.ts'
import { personTable } from './tables.ts'

/**
 * The desktop window's way in, end to end through the production auth routes over real
 * PostgreSQL: a device-code exchange approved by a signed-in browser, then the trade of the
 * exchange's bearer token for a session cookie (`cookie.ts`). Nothing is mocked; the cookie under
 * test is the one Better Auth itself signs.
 */
const testLayer = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  changesLayer.pipe(Layer.provide(testDatabaseLayer)),
)

const origin = 'http://127.0.0.1:8787'
const json = { 'content-type': 'application/json', origin }
const CLIENT = 'vivid-desktop'

/** One request to the production auth routes. */
const call = (auth: AuthInstance, path: string, init: RequestInit) =>
  auth.fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(`${origin}/api/auth/${path}`, init)),
    ),
    Effect.provide(localAuthRuntimeLayer),
  )

/** The cookies a response set, as the `cookie` header a browser would send back. */
const cookiesOf = (response: HttpServerResponse.HttpServerResponse) =>
  Object.values(response.cookies.cookies)
    .map((entry) => `${entry.name}=${entry.valueEncoded}`)
    .join('; ')

/**
 * Whether a response set a session cookie that holds a session. A refusal still names the cookie,
 * to expire it with an empty value, so the name alone proves nothing.
 */
const setsSession = (response: HttpServerResponse.HttpServerResponse) =>
  Object.values(response.cookies.cookies).some(
    (entry) => entry.name.endsWith('session_token') && entry.value !== '',
  )

/** A response body decoded with the schema the test reads it by. */
const bodyOf = <Value, Encoded>(
  response: HttpServerResponse.HttpServerResponse,
  schema: Schema.Codec<Value, Encoded>,
) =>
  Effect.promise(() => HttpServerResponse.toWeb(response).text()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
  )

const Code = Schema.Struct({ device_code: Schema.String, user_code: Schema.String })
const Grant = Schema.Struct({ access_token: Schema.RedactedFromValue(Schema.String) })
const Here = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ email: Schema.String }),
})

/** A Person signed up through the production route, removed again when the test's scope closes. */
const signedUp = Effect.fn('CookieTest.signedUp')(function* (auth: AuthInstance) {
  const database = yield* Database
  const email = `${NodeCrypto.randomUUID()}@example.test`
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.email, email))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Cookie fixture cleanup failed'))),
    ),
  )
  const response = yield* call(auth, 'sign-up/email', {
    method: 'POST',
    headers: json,
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
const exchanged = Effect.fn('CookieTest.exchanged')(function* (
  auth: AuthInstance,
  browser: string,
) {
  const issued = yield* call(auth, 'device/code', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ client_id: CLIENT }),
  })
  const code = yield* bodyOf(issued, Code)
  const claimed = yield* call(auth, `device?user_code=${encodeURIComponent(code.user_code)}`, {
    method: 'GET',
    headers: { origin, cookie: browser },
  })
  expect(claimed.status).toBe(200)
  const approved = yield* call(auth, 'device/approve', {
    method: 'POST',
    headers: { ...json, cookie: browser },
    body: JSON.stringify({ userCode: code.user_code }),
  })
  expect(approved.status).toBe(200)
  const granted = yield* call(auth, 'device/token', {
    method: 'POST',
    headers: json,
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

describe.skipIf(!testDatabaseConfigured)('trading a session token for its cookie', () => {
  layer(testLayer)((it) => {
    it.effect('gives a window that signed in with a code a cookie for that same session', () =>
      Effect.gen(function* () {
        const auth = yield* authEffect
        const person = yield* signedUp(auth)
        const token = yield* exchanged(auth, person.cookie)

        const adopted = yield* call(auth, 'adopt-session', {
          method: 'POST',
          headers: { origin, authorization: `Bearer ${Redacted.value(token)}` },
        })
        expect(adopted.status).toBe(204)
        expect(setsSession(adopted)).toBe(true)
        const cookie = cookiesOf(adopted)

        // The cookie alone, with no bearer, is now the window's session: the same Person, and
        // the session the exchange made, not a second one.
        const byCookie = yield* bodyOf(
          yield* call(auth, 'get-session', { method: 'GET', headers: { origin, cookie } }),
          Here,
        )
        const byToken = yield* bodyOf(
          yield* call(auth, 'get-session', {
            method: 'GET',
            headers: { origin, authorization: `Bearer ${Redacted.value(token)}` },
          }),
          Here,
        )
        expect(byCookie.user.email).toBe(person.email)
        expect(byCookie.session.id).toBe(byToken.session.id)
      }).pipe(Effect.scoped),
    )

    it.effect('sets no cookie for a caller with no session or a token it never issued', () =>
      Effect.gen(function* () {
        const auth = yield* authEffect
        const nobody = yield* call(auth, 'adopt-session', {
          method: 'POST',
          headers: { origin },
        })
        const forged = yield* call(auth, 'adopt-session', {
          method: 'POST',
          headers: { origin, authorization: `Bearer ${NodeCrypto.randomUUID()}` },
        })
        for (const response of [nobody, forged]) {
          expect(response.status).toBe(401)
          expect(setsSession(response)).toBe(false)
        }
      }).pipe(Effect.scoped),
    )
  })
})
