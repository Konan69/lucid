import * as NodeProcess from 'node:process'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import { GoogleOAuthConfiguration, ServerConfig } from '../config.ts'
import { databaseLayer } from './client.ts'

/** Synchronous suite gating reads only the isolated test variable, never `DATABASE_URL`. */
export const testDatabaseConfigured = Object.hasOwn(NodeProcess.env, 'VIVID_TEST_DATABASE_URL')

/**
 * The server configuration every integration suite shares. `DATABASE_URL` is the disposable test
 * database and nothing else, so a store that opens its own connection still cannot reach a
 * developer's data.
 */
export const testConfigLayer = Layer.unwrap(
  Config.Redacted('VIVID_TEST_DATABASE_URL').pipe(
    Effect.map((databaseUrl) =>
      Layer.succeed(ServerConfig, {
        DATABASE_URL: databaseUrl,
        AUTH_SECRET: Redacted.make('test-Auth_secret-0123456789-ABCDEFG'),
        RUNTIME_URL: new URL('http://127.0.0.1:1'),
        RUNTIME_TOKEN: Redacted.make('test-runtime-token'),
        PORT: 8787,
        PUBLIC_URL: new URL('http://127.0.0.1:8787'),
        GOOGLE_OAUTH: GoogleOAuthConfiguration.Disabled(),
      }),
    ),
  ),
)

/** Provides the production Effect Drizzle adapter against the disposable test database. */
export const testDatabaseLayer = databaseLayer.pipe(Layer.provide(testConfigLayer))
