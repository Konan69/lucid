import * as Crypto from 'node:crypto'
import { Effect, Context, Layer, Option, Redacted, Schema } from 'effect'
import { exportJWK, importPKCS8, jwtVerify, SignJWT } from 'jose'
import { Auth } from '../auth/provider.ts'
import { optionalSetting, requiredSetting, ServerConfig, settingSecret } from '../config.ts'

export const EXECUTOR_CLIENT = 'vivid-executor'
export const ISSUER_PATH = '/api/connections/sso'

/** Executor is the only relying party; failures never echo codes, claims or credentials. */
export class ExecutorSignInInvalid extends Schema.TaggedError<ExecutorSignInInvalid>()(
  'ExecutorSignInInvalid', {},
) {}
export class ExecutorSignInUnavailable extends Schema.TaggedError<ExecutorSignInUnavailable>()(
  'ExecutorSignInUnavailable', {},
) {}

const Email = Schema.String.check(Schema.isPattern(/^m-[a-f0-9]{24}@members\.vivid\.invalid$/))
export const ExecutorAuthorization = Schema.Struct({
  response_type: Schema.Literal('code'),
  client_id: Schema.Literal(EXECUTOR_CLIENT),
  redirect_uri: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  code_challenge: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  code_challenge_method: Schema.Literal('S256'),
})
const Grant = Schema.Struct({ email: Email, authorization: ExecutorAuthorization })
const grantJson = Schema.fromJsonString(Grant)
export const ExecutorTokenRequest = Schema.Struct({
  grant_type: Schema.Literal('authorization_code'),
  client_id: Schema.Literal(EXECUTOR_CLIENT),
  client_secret: Schema.RedactedFromValue(Schema.NonEmptyString),
  code: Schema.NonEmptyString,
  redirect_uri: Schema.NonEmptyString,
  code_verifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/)),
})
const Profile = Schema.Struct({ sub: Email, email: Email, email_verified: Schema.Literal(true), name: Schema.Literal('Vivid member') })

/** The existing Better Auth verification adapter provides durable, atomic one-use consumption. */
const sdk = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: () => new ExecutorSignInUnavailable(),
})
const invalid = () => new ExecutorSignInInvalid()
const digest = (text: string) => Crypto.createHash('sha256').update(text).digest('base64url')
const sameSecret = (a: string, b: string) => Crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)))

/** One issuer shared by browser authorization and trusted server-side member provisioning. */
const makeIssuer = Effect.fn('ExecutorSignIn.make')(function* () {
  const config = yield* ServerConfig
  const auth = yield* Auth
  const adapter = (yield* sdk(() => auth.$context)).internalAdapter
  const publicUrl = yield* optionalSetting('VIVID_EXECUTOR_PUBLIC_URL', Schema.URLFromString)
  const secret = yield* requiredSetting('VIVID_EXECUTOR_SSO_SECRET', settingSecret)
  const pem = yield* requiredSetting('VIVID_EXECUTOR_SSO_SIGNING_KEY', settingSecret, 'an RSA PKCS8 private key in PEM')
  const key = yield* sdk(() => importPKCS8(Redacted.value(pem), 'RS256', { extractable: true }))
  const publicKey = Crypto.createPublicKey(Redacted.value(pem))
  const jwk = yield* sdk(() => exportJWK(publicKey))
  const kid = digest(JSON.stringify(jwk))
  const issuer = new URL(ISSUER_PATH, config.PUBLIC_URL).href
  const dashboard = Option.match(publicUrl, {
    onNone: () => Effect.fail(new ExecutorSignInUnavailable()),
    onSome: (url) => Effect.succeed(url.origin),
  })
  /** Match the exact callback registered for this single client before issuing any redirect. */
  const authorize = Effect.fn('ExecutorSignIn.authorize')(function* (input: typeof ExecutorAuthorization.Type) {
    const origin = yield* dashboard
    if (input.redirect_uri !== `${origin}/api/auth/callback/sso` ||
      !input.scope.split(' ').includes('openid') ||
      input.scope.split(' ').some((scope) => !['openid', 'email', 'profile'].includes(scope)))
      return yield* invalid()
    return input
  })
  /** No browser/session check here: only the authenticated HTTP adapter or member provisioner calls it. */
  const issue = Effect.fn('ExecutorSignIn.issue')(function* (email: string, input: typeof ExecutorAuthorization.Type) {
    const authorization = yield* authorize(input)
    const identity = yield* Schema.decodeUnknownEffect(Email)(email).pipe(Effect.mapError(invalid))
    const code = Crypto.randomBytes(32).toString('base64url')
    const value = yield* Schema.encodeEffect(grantJson)({ email: identity, authorization }).pipe(Effect.mapError(invalid))
    yield* sdk(() => adapter.createVerificationValue({ identifier: `executor-sso:${digest(code)}`, value, expiresAt: new Date(Date.now() + 60_000) }))
    const target = new URL(authorization.redirect_uri)
    target.searchParams.set('code', code)
    target.searchParams.set('state', authorization.state)
    return target
  })
  /** Client authentication precedes atomic consumption; PKCE and the callback remain bound to the code. */
  const token = Effect.fn('ExecutorSignIn.token')(function* (input: typeof ExecutorTokenRequest.Type) {
    if (!sameSecret(Redacted.value(input.client_secret), Redacted.value(secret))) return yield* invalid()
    const row = yield* sdk(() => adapter.consumeVerificationValue(`executor-sso:${digest(input.code)}`))
    if (row === null || row.expiresAt.getTime() <= Date.now()) return yield* invalid()
    const grant = yield* Schema.decodeUnknownEffect(grantJson)(row.value).pipe(Effect.mapError(invalid))
    if (grant.authorization.redirect_uri !== input.redirect_uri || grant.authorization.code_challenge !== digest(input.code_verifier)) return yield* invalid()
    const profile = Profile.make({ sub: grant.email, email: grant.email, email_verified: true, name: 'Vivid member' })
    const id = new SignJWT({ ...profile, nonce: grant.authorization.nonce }).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setAudience(EXECUTOR_CLIENT).setIssuedAt().setExpirationTime('5m')
    const access = new SignJWT(profile).setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' }).setIssuer(issuer).setAudience(`${issuer}/userinfo`).setIssuedAt().setExpirationTime('5m')
    return { id_token: yield* sdk(() => id.sign(key)), access_token: yield* sdk(() => access.sign(key)), token_type: 'Bearer', expires_in: 300, scope: 'openid email profile' }
  })
  /** Access tokens cannot substitute for ID tokens because their audience and protected type differ. */
  const userinfo = Effect.fn('ExecutorSignIn.userinfo')(function* (bearer: string) {
    const verified = yield* Effect.tryPromise({
      try: () => jwtVerify(bearer, publicKey, { issuer, audience: `${issuer}/userinfo`, algorithms: ['RS256'], typ: 'at+jwt' }),
      catch: invalid,
    })
    return yield* Schema.decodeUnknownEffect(Profile)(verified.payload).pipe(Effect.mapError(invalid))
  })
  return { dashboard, authorize, issue, token, userinfo, jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }, discovery: {
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/userinfo`,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], scopes_supported: ['openid', 'email', 'profile'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'],
  } }
})

export class ExecutorSignIn extends Context.Service<ExecutorSignIn, Effect.Success<ReturnType<typeof makeIssuer>>>()('vivid/ExecutorSignIn') {}
export const executorSignInLayer = Layer.effect(ExecutorSignIn, makeIssuer())
