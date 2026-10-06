import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { ConnectionId, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import { Clock, Config, Effect, Layer, Option, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { Database } from '../database/client.ts'
import type { ChainFixture } from '../runtime/chains.ts'
import {
  Executor,
  ExecutorAppId,
  ExecutorOwnerId,
  ExecutorProfileId,
  ExecutorReferences,
  ExecutorCallOutcome,
  executorLayer,
} from './executor.ts'
import { encodeReferences } from './records.ts'
import { connections } from './tables.ts'

/** Port the retained record mechanism from Executor packages/sdk/test/app-data.test.ts `source`.
 * Each deployment has its own real SQLite store. Vivid names replace the reference's names, and
 * mutation outputs omit row handles; polling still uses stable provider ids behind the server.
 * This service is a real Executor fixture, not evidence of a third-party OAuth connection.
 */
const source = `import { query, mutation, defineApp, defineDatabase, table, object, string } from "apps";
const database = defineDatabase({ records: table({ subject: string() }) });
export default defineApp({ accounts: {}, database }, async () => ({
  queries: { records: query({ description: "Read saved proof records in creation order", input: object({}) }, async ({ db }) => db.records.withIndex("by_creation").collect()) },
  mutations: { save: mutation({ description: "Save a proof record", input: object({ subject: string() }) }, async ({ db }, value) => { await db.records.insert(value); return { saved: true, subject: value.subject }; }) }
}));`

const Deployment = Schema.Struct({ id: ExecutorAppId })
const Profile = Schema.Struct({ id: ExecutorProfileId })
export const ProofRecords = Schema.Array(
  Schema.Struct({ id: Schema.String, subject: Schema.String }),
)

const decodeRecords = Schema.decodeUnknownEffect(ProofRecords)
const cleanupFailed = () => Effect.sync(() => expect.fail('Executor proof cleanup failed'))
const successfulRemoval = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.sync(() => expect(response.status >= 200 && response.status < 300).toBe(true))

/** Hosted management derives ownership from the authenticated organization. Match the adapter's
 * URL prefix, including an operator-supplied base path, without exposing its URL or key in logs. */
const hostedEndpoint = Effect.fn('ThreadProof.hostedEndpoint')(function* () {
  const endpoint = yield* Config.URL('VIVID_EXECUTOR_URL')
  const organization = yield* Config.schema(Schema.NonEmptyString, 'VIVID_EXECUTOR_ORGANIZATION')
  return `${endpoint.href.replace(/\/$/u, '')}/api/organizations/${encodeURIComponent(organization)}`
})

/** Management calls decode the deployed host's response, keep its key redacted and refuse
 * non-success statuses. No app creation, write, tool dispatch or model request is retried.
 */
const executorRequest = Effect.fn('ThreadProof.executorRequest')(function* (
  path: string,
  body: Schema.Json,
) {
  const endpoint = yield* hostedEndpoint()
  const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(`${endpoint}${path}`).pipe(HttpClientRequest.bearerToken(key)),
    body,
  )
  const response = yield* (yield* HttpClient.HttpClient).execute(request).pipe(
    Effect.mapError(() =>
      ServiceUnavailable.make({
        service: 'connections',
        message: 'Executor proof management request failed',
      }),
    ),
  )
  expect(
    response.status >= 200 && response.status < 300,
    'Executor management request failed',
  ).toBe(true)
  return response
})

/** HostedApps.deploy returns App directly; HostedProfiles.create derives owner/subject from
 * membership. Allocate an isolated real service/profile before linking it to this fixture's Person. Cleanup
 * is installed before deployment; provider resources are removed before the Person cascades.
 * Only private test rows are inserted; credentials remain exclusively inside Executor.
 */
export const proofConnection = Effect.fn('ThreadProof.connection')(function* (
  fixture: ChainFixture,
) {
  const endpoint = yield* hostedEndpoint()
  const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
  const http = yield* HttpClient.HttpClient
  const owner = ExecutorOwnerId.make(`thread-proof-${NodeCrypto.randomUUID()}`)
  let created = Option.none<typeof ExecutorAppId.Type>()
  yield* Effect.addFinalizer(() =>
    Option.match(created, {
      onNone: () => Effect.void,
      onSome: (id) =>
        http
          .execute(
            HttpClientRequest.delete(`${endpoint}/apps/${encodeURIComponent(id)}`).pipe(
              HttpClientRequest.bearerToken(key),
            ),
          )
          .pipe(Effect.tap(successfulRemoval), Effect.asVoid, Effect.catch(cleanupFailed)),
    }),
  )
  const deployed = yield* HttpClientResponse.schemaBodyJson(Deployment)(
    yield* executorRequest('/apps/deploy', {
      name: `Proof Records ${NodeCrypto.randomUUID()}`,
      files: [{ path: 'index.ts', content: source }],
    }),
  )
  created = Option.some(deployed.id)
  const profile = yield* HttpClientResponse.schemaBodyJson(Profile)(
    yield* executorRequest(`/apps/${encodeURIComponent(deployed.id)}/profiles`, {
      name: 'Proof Records',
      accounts: {},
      idempotencyKey: NodeCrypto.randomUUID(),
    }),
  )
  const references = ExecutorReferences.cases.Public.make({
    app: deployed.id,
    profile: profile.id,
    owner,
    service: ServiceId.make('proof-records'),
    appOwnership: 'Shared',
  })
  const context = yield* Layer.build(executorLayer)
  const executor = yield* Executor.pipe(Effect.provideContext(context))
  expect((yield* executor.status(references))._tag).toBe('Ready')
  const tools = yield* executor.tools(references)
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['queries.records', 'mutations.save']),
  )
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const id = ConnectionId.make(NodeCrypto.randomUUID())
  yield* database.run(
    database.insert(connections).values({
      id,
      personId: fixture.personId,
      companyId: null,
      service: references.service,
      serviceName: 'Proof Records',
      name: null,
      identity: null,
      references: encodeReferences(references),
      status: 'ready',
      reason: null,
      createdAt: now,
      updatedAt: now,
    }),
  )
  /** Observe real storage through Executor, not Vivid's action receipt or a copied mock value. */
  const records = Effect.fn('ThreadProof.records')(function* () {
    const result = yield* executor.call({ references, tool: 'queries.records', input: {} })
    if (!ExecutorCallOutcome.guards.Completed(result))
      return yield* Effect.sync(() => expect.fail('Executor record read did not complete'))
    return yield* decodeRecords(result.value)
  })
  return { id, references, executor, records }
})
