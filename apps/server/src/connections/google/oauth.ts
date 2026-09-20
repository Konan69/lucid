import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import type { GoogleOAuthConfiguration } from '../../config.ts'
import { ConnectionFailure } from '../types.ts'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

const GoogleCodeTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
})
const GoogleRefreshTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
})

type GoogleOAuthConfig = ReturnType<typeof GoogleOAuthConfiguration.Enabled>

/** Builds the provider redirect without reading configuration or performing module-load work. */
export const getGoogleAuthUrl = (
  config: GoogleOAuthConfig,
  scopes: ReadonlyArray<string>,
  state: string,
) => {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri.toString(),
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

/** Exchanges a browser authorization code while keeping the client secret in this server module. */
export const exchangeGoogleCode = Effect.fn('GoogleOAuth.exchangeCode')(function* (
  config: GoogleOAuthConfig,
  code: string,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: Redacted.value(config.clientSecret),
          code,
          grant_type: 'authorization_code',
          redirect_uri: config.redirectUri.toString(),
        }),
      }),
    catch: () => new ConnectionFailure({ message: 'The Google OAuth request failed' }),
  })
  if (!response.ok)
    return yield* Effect.fail(new ConnectionFailure({ message: 'Google authorization failed' }))
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new ConnectionFailure({ message: 'The Google OAuth request failed' }),
  })
  const decodeToken = Schema.decodeUnknownEffect(Schema.fromJsonString(GoogleCodeTokenResponse))
  const token = yield* decodeToken(body).pipe(
    Effect.mapError(() => new ConnectionFailure({ message: 'Google returned invalid tokens' })),
  )
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1_000,
    scope: token.scope,
  }
})

/** Refreshes an expired access token and returns only the server-side credential patch. */
export const refreshGoogleToken = Effect.fn('GoogleOAuth.refreshToken')(function* (
  config: GoogleOAuthConfig,
  refreshToken: string,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: Redacted.value(config.clientSecret),
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      }),
    catch: () => new ConnectionFailure({ message: 'The Google OAuth request failed' }),
  })
  if (!response.ok)
    return yield* Effect.fail(new ConnectionFailure({ message: 'Google token refresh failed' }))
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new ConnectionFailure({ message: 'The Google OAuth request failed' }),
  })
  const decodeToken = Schema.decodeUnknownEffect(Schema.fromJsonString(GoogleRefreshTokenResponse))
  const token = yield* decodeToken(body).pipe(
    Effect.mapError(() => new ConnectionFailure({ message: 'Google returned invalid tokens' })),
  )
  return { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1_000 }
})

/** Revokes a provider token before the local credential row is removed. */
export const revokeGoogleToken = Effect.fn('GoogleOAuth.revokeToken')(function* (token: string) {
  yield* Effect.tryPromise({
    try: () => fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }),
    catch: () => new ConnectionFailure({ message: 'The Google OAuth request failed' }),
  })
})
