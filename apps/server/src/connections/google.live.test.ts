import * as NodeProcess from 'node:process'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, ServiceAuthorization } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import {
  Executor,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorStep,
  executorLayer,
  installationCaller,
} from './executor.ts'
import { googleReturnPath, googleServices, type GoogleService } from './google.ts'

/** The address the disposable Executor returns every sign-in to. Start it with
 * `EXECUTOR_OAUTH_CALLBACK_URL` set to exactly this, as `infra/railway.ts` does with the hosted
 * server's own address; Executor ignores a return address sent with a request. */
const returnAddress = `https://vivid.example.test${googleReturnPath}`
const clientId = 'isolated-test-client'

/** Authored OAuth requirements are independent of the source generator and service metadata. */
const requiredScopes = new Map([
  ['Gmail', ['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.settings.basic']],
  ['Google Calendar', ['https://www.googleapis.com/auth/calendar']],
  ['Google Drive', ['https://www.googleapis.com/auth/drive']],
  ['Google Docs', ['https://www.googleapis.com/auth/documents']],
  [
    'Google Sheets',
    ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
  ],
  ['Google Tasks', ['https://www.googleapis.com/auth/tasks']],
])

const liveLayer = executorLayer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        // A stand-in client: Google is asked only for its published sign-in metadata, and no
        // Person signs in, so no real client or account is involved.
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
        VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_PUBLIC_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
      }),
    ),
  ),
)

/** Begin one Connection for a separate owner and remove its dedicated app and pending request
 * even if inspection fails. A second Connection must receive another app. */
const begun = Effect.fn('GoogleProof.begin')(function* <A>(
  google: GoogleService,
  inspect: (
    step: typeof ExecutorStep.cases.OpenSignIn.Type,
    references: typeof ExecutorReferences.cases.GoogleSigningIn.Type,
  ) => A,
) {
  const executor = yield* Executor
  return yield* Effect.acquireUseRelease(
    executor
      .as(installationCaller)
      .begin({
        connectionId: ConnectionId.make(crypto.randomUUID()),
        owner: ExecutorOwnerId.make(`google-proof-${crypto.randomUUID()}`),
        subject: 'google-proof-person',
        service: google.service,
        label: 'Google verification',
        returnAddress,
      })
      .pipe(
        Effect.catchTags({
          ExecutorSignInRequired: (error) =>
            executor
              .as(installationCaller)
              .remove(error.references)
              .pipe(Effect.andThen(Effect.fail(error))),
          ExecutorAuthorizationUnavailable: (error) =>
            executor
              .as(installationCaller)
              .remove(error.references)
              .pipe(Effect.andThen(Effect.fail(error))),
        }),
      ),
    (step) => {
      if (!ExecutorStep.guards.OpenSignIn(step)) return expect.fail('Google consent URL required')
      if (!ExecutorReferences.guards.GoogleSigningIn(step.references))
        return expect.fail('Google correlation required')
      return Effect.succeed(inspect(step, step.references))
    },
    (step) =>
      executor
        .as(installationCaller)
        .remove(step.references)
        .pipe(
          Effect.catch(() =>
            Effect.sync(() => expect.fail('Could not remove owned Google proof connection')),
          ),
        ),
  )
})

/**
 * The real adapter against a disposable hosted Executor, with nothing installed on it beforehand:
 * no product database and no Google token exchange. For each of the six services the first Begin
 * deploys Vivid's own source and the second deploys a distinct app. Both return Google's consent
 * address carrying the client, the return address and the state Vivid stored.
 *
 * Run on the published `executor-selfhost:2.0.0-beta.23` image, which must be started
 * with `EXECUTOR_OAUTH_CALLBACK_URL` set to `returnAddress` above. Assertions compare to booleans
 * so a failure prints neither a client value nor a consent address.
 */
describe.skipIf(NodeProcess.env['VIVID_LIVE_GOOGLE'] !== '1')(
  'Google Integrations on Executor',
  () => {
    layer(liveLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
      it.effect(
        'offers six services with dedicated apps per Connection and Google consent addresses',
        () =>
          Effect.gen(function* () {
            const catalog = yield* (yield* Executor).catalog
            for (const google of googleServices) {
              expect(
                catalog.some(
                  (entry) =>
                    entry.id === google.service &&
                    ServiceAuthorization.guards.SignIn(entry.authorization),
                ),
              ).toBe(true)
              const first = yield* begun(google, (step, references) => {
                const address = new URL(step.address)
                const sent = (name: string) => address.searchParams.get(name)
                expect(address.origin === 'https://accounts.google.com').toBe(true)
                expect(address.pathname === '/o/oauth2/v2/auth').toBe(true)
                expect(sent('client_id') === clientId).toBe(true)
                expect(sent('redirect_uri') === returnAddress).toBe(true)
                expect(sent('state') === references.googleState).toBe(true)
                const scopes = requiredScopes.get(google.name)
                if (scopes === undefined)
                  expect.fail('OAuth expectations required for this service')
                const supplied = sent('scope')
                if (supplied === null) expect.fail('Google consent must request its scopes')
                expect(supplied.split(' ').toSorted()).toEqual(
                  ['openid', 'email', 'profile', ...scopes].toSorted(),
                )
                // Google issues a refresh token only for offline access, and takes no resource.
                expect(sent('access_type') === 'offline').toBe(true)
                expect(address.searchParams.has('resource')).toBe(false)
                return references.app
              })
              const second = yield* begun(google, (_step, references) => references.app)
              expect(second === first).toBe(false)
            }
          }),
        { timeout: 240_000 },
      )
    })
  },
)
