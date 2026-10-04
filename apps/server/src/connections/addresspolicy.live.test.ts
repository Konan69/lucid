import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import { ConnectionAddress, connectionAddressLayer } from './address.ts'

const url = NodeProcess.env['VIVID_TEST_EXECUTOR_URL']
const key = NodeProcess.env['VIVID_TEST_EXECUTOR_KEY']
const organization = NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION']
const enabled = NodeProcess.env['VIVID_LIVE_ADDRESS_POLICY'] === '1'
const destinations = [
  'https://127.0.0.1/mcp',
  'https://10.0.0.1/mcp',
  'https://172.16.0.1/mcp',
  'https://192.168.0.1/mcp',
  'https://169.254.169.254/mcp',
  'https://[fc00::1]/mcp',
  'https://[fe80::1]/mcp',
  'https://postgres.railway.internal/mcp',
  // Public names with private answers exercise the independent socket-time checks.
  'https://127.0.0.1.sslip.io/mcp',
  'https://10.0.0.1.sslip.io/mcp',
]

/** Real DNS and the disposable published Executor exercise independent trust boundaries.
 * packages/utils/src/url-policy.ts parseDestination rejects literals/internal names; the
 * self-host workerd PUBLIC_FETCH service blocks private DNS answers at connection time.
 * Calling Executor directly ensures Vivid's inspection cannot mask an Executor policy gap.
 */
describe.skipIf(!enabled)('Public destination live policy', () => {
  it.live(
    'Vivid refuses internal addresses and public names resolving to private addresses',
    () =>
      Effect.gen(function* () {
        const reader = yield* ConnectionAddress
        for (const destination of destinations) {
          const error = yield* reader.inspect(destination).pipe(Effect.flip)
          expect(['ConnectionAddressInvalid', 'ConnectionAddressUnreachable']).toContain(error._tag)
        }
      }).pipe(Effect.provide(connectionAddressLayer)),
    { timeout: 120_000 },
  )

  it.live(
    'Executor independently refuses the same destinations before creating an app',
    () =>
      Effect.gen(function* () {
        if (url === undefined || key === undefined || organization === undefined)
          return expect.fail('Supply disposable Executor test authority')
        const client = yield* HttpClient.HttpClient
        for (const destination of destinations) {
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${url}/api/organizations/${organization}/apps/import`).pipe(
              HttpClientRequest.bearerToken(key),
            ),
            { source: { kind: 'mcp', name: 'Public policy proof', url: destination } },
          )
          const response = yield* client.execute(request)
          expect(response.status).toBe(422)
          // Assert a policy refusal, rather than accepting auth failures as proof of isolation.
          const refusal = yield* response.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ _tag: Schema.Literal('CatalogImportFailed'), code: Schema.String }),
              ),
            ),
          )
          expect(['mcp_url', 'mcp_probe', 'mcp_discovery']).toContain(refusal.code)
        }
        return yield* Effect.void
      }).pipe(Effect.provide(NodeHttpClient.layerUndici)),
    { timeout: 120_000 },
  )
})
