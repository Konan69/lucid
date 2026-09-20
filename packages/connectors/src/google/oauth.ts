import { Config, Effect, Redacted, Schema } from 'effect'
import type { ConnectorCredential } from '../types.ts'

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
const decodeCodeTokenResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(GoogleCodeTokenResponse),
)
const decodeRefreshTokenResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(GoogleRefreshTokenResponse),
)

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function getGoogleAuthUrl(
  config: GoogleOAuthConfig,
  scopes: string[],
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  code: string,
): Promise<Omit<ConnectorCredential, 'id' | 'createdAt'> & { scope: string }> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Token exchange failed: ${error}`)
  }

  const data = decodeCodeTokenResponse(await response.text())

  return {
    connectorId: 'gmail',
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  }
}

export async function refreshGoogleToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Token refresh failed: ${error}`)
  }

  const data = decodeRefreshTokenResponse(await response.text())

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(`${GOOGLE_REVOKE_URL}?token=${token}`, { method: 'POST' })
}

const loadGoogleConfig = Effect.fn('GoogleOAuth.loadConfig')(function* () {
  const clientId = yield* Config.String('GOOGLE_CLIENT_ID')
  const clientSecret = yield* Config.Redacted('GOOGLE_CLIENT_SECRET')
  const redirectUri = yield* Config.String('GOOGLE_REDIRECT_URI')
  return { clientId, clientSecret: Redacted.value(clientSecret), redirectUri }
})

/** Loads Google OAuth configuration at the synchronous Connector framework boundary. */
export function getGoogleConfig(): GoogleOAuthConfig {
  return Effect.runSync(loadGoogleConfig())
}
