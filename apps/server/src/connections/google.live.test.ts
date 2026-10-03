import * as NodeProcess from 'node:process'
import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, ServiceAuthorization } from '@vivid/contracts'
import { Console, Effect, Layer, Option, Redacted } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import {
  Executor,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorStep,
  executorLayer,
} from './executor.ts'
import { googleReturnPath, loadGoogleInstallation } from './google.ts'

const liveLayer = executorLayer.pipe(Layer.provide(FetchHttpClient.layer))

/** Native Executor requests prove operator-client provisioning for separate Vivid owners.
 * No product database or Google token exchange is involved. Every temporary profile/request
 * is removed; the encrypted operator client registration is intentionally retained in Executor.
 * Assertions use booleans so a failure cannot print either client value or the consent URL.
 */
describe.skipIf(NodeProcess.env['VIVID_LIVE_GOOGLE'] !== '1')(
  'Google operator provisioning',
  () => {
    it.live(
      'offers installed Google services and returns real consent URLs for independent owners',
      () =>
        Effect.gen(function* () {
          const installation = yield* loadGoogleInstallation()
          if (Option.isNone(installation)) expect.fail('Google operator configuration required')
          const executor = yield* Executor
          const catalog = yield* executor.catalog()
          for (const app of installation.value.apps) {
            expect(
              catalog.some(
                (entry) =>
                  entry.id === app.service &&
                  ServiceAuthorization.guards.SignIn(entry.authorization),
              ),
            ).toBe(true)
            yield* Effect.acquireUseRelease(
              executor
                .begin({
                  connectionId: ConnectionId.make(crypto.randomUUID()),
                  owner: ExecutorOwnerId.make(`google-proof-${crypto.randomUUID()}`),
                  subject: 'google-proof-person',
                  service: app.service,
                  label: 'Google verification',
                  returnAddress: 'https://vivid.example.test/api/connections/return/verification',
                })
                .pipe(
                  Effect.catchTags({
                    ExecutorSignInRequired: (error) =>
                      executor.remove(error.references).pipe(Effect.andThen(Effect.fail(error))),
                    ExecutorAuthorizationUnavailable: (error) =>
                      executor.remove(error.references).pipe(Effect.andThen(Effect.fail(error))),
                  }),
                ),
              Effect.fn('GoogleProof.inspect')(function* (step) {
                if (!ExecutorStep.guards.OpenSignIn(step))
                  expect.fail('Google consent URL required')
                if (!ExecutorReferences.guards.GoogleSigningIn(step.references))
                  expect.fail('Google correlation required')
                const address = new URL(step.address)
                expect(address.hostname === 'accounts.google.com').toBe(true)
                expect(address.pathname === '/o/oauth2/v2/auth').toBe(true)
                expect(
                  address.searchParams.get('client_id') ===
                    Redacted.value(installation.value.client.clientId),
                ).toBe(true)
                expect(
                  address.searchParams.get('redirect_uri') ===
                    `https://vivid.example.test${googleReturnPath}`,
                ).toBe(true)
                expect(step.references.googleState === address.searchParams.get('state')).toBe(true)
                const scope = address.searchParams.get('scope')
                expect(scope !== null && scope.includes('https://www.googleapis.com/auth/')).toBe(
                  true,
                )
                yield* Console.log({
                  service: app.service,
                  host: address.hostname,
                  path: address.pathname,
                  redirect_uri: address.searchParams.get('redirect_uri'),
                  scope,
                })
              }),
              Effect.fn('GoogleProof.cleanup')((step) => executor.remove(step.references)),
            )
          }
        }).pipe(Effect.provide(liveLayer)),
      { timeout: 120_000 },
    )
  },
)
