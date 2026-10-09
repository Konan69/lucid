import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { ConnectionId, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import { Clock, Config, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { Database } from '../database/client.ts'
import type { ChainFixture } from '../runtime/chains.ts'
import {
  Executor,
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorOwnerId,
  ExecutorProfileId,
  ExecutorReferences,
  ExecutorCallOutcome,
  ExecutorStatus,
  executorLayer,
} from './executor.ts'
import { googleAppsVersion } from './google.ts'
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
      references: yield* encodeReferences(references),
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

/**
 * A service a Person can hold several accounts on, for proofs about telling accounts apart.
 *
 * The provider takes a key and a plain `who`: the address the account answers to. Its `health`
 * says that address, as Vivid's Google apps say a Google account's (`google.ts`), so Executor has
 * an identity to give when it is asked. `save` records which account saved each record, because
 * profiles of one app share its data: that field is the only evidence of the account a call went
 * through. A package manifest names the `apps` version the hosted build requires, and the tools
 * sit in a router under `tools`, which that version requires too (its `storage.md`); the older
 * `queries`/`mutations` shape of `source` above no longer loads there.
 */
const accountsSource = `import { query, mutation, defineApp, defineDatabase, defineProvider, secrets, plain, table, json, object, string, router } from "apps";
const service = defineProvider({ name: "Proof Accounts", auth: { key: secrets({ label: "Key", fields: object({ who: plain(string()), token: string() }) }) }, async health({ account }) { return { accountInfo: { email: account.fields.who } }; } });
const database = defineDatabase({ records: table({ subject: string(), by: string() }).index("by_subject", ["subject"]) });
const requirements = { accounts: { service }, database };
const records = query({ description: "Read the saved proof records that have one subject", input: object({ subject: string() }), output: json() }, async ({ db }, { subject }) => db.records.withIndex("by_subject", (q) => q.eq("subject", subject)).take(50));
const save = mutation({ description: "Save a proof record through this account", input: object({ subject: string() }), output: json() }, async ({ db, accounts }, { subject }) => { await db.records.insert({ subject, by: accounts.service.fields.who }); return { saved: true, subject }; });
export default defineApp(requirements, { tools: router({ records, save }) });`

const Authorization = Schema.Struct({ id: Schema.NonEmptyString })
const Account = Schema.Struct({ id: ExecutorAccountId })
export const AccountRecords = Schema.Array(
  Schema.Struct({ subject: Schema.String, by: Schema.String }),
)
const decodeAccountRecords = Schema.decodeUnknownEffect(AccountRecords)

/**
 * Two real accounts on one real Executor app, linked to this fixture's Person as two Connections
 * of one service. Each is connected the way a keyed service is (a profile, a targeted connection
 * request, a submitted key), so each Connection holds its own Executor account. Who each account
 * is comes from Executor itself, through the adapter (`Executor.identity`), and is written on the
 * row as the store writes it once a Connection is ready. The rows are inserted because the proof
 * service is not in the catalogue, which is the only way a Person begins one; everything read
 * afterwards (names, discovery, approval, the call) is the product's own path.
 */
export const proofAccounts = Effect.fn('ThreadProof.accounts')(function* (
  fixture: ChainFixture,
  whose: readonly [string, string],
) {
  const endpoint = yield* hostedEndpoint()
  const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
  const http = yield* HttpClient.HttpClient
  const owner = ExecutorOwnerId.make(`accounts-proof-${NodeCrypto.randomUUID()}`)
  const service = ServiceId.make('proof-accounts')
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
      name: `Proof Accounts ${NodeCrypto.randomUUID()}`,
      files: [
        { path: 'index.ts', content: accountsSource },
        {
          path: 'package.json',
          content: JSON.stringify({
            name: 'vivid-proof-accounts',
            private: true,
            type: 'module',
            dependencies: { apps: googleAppsVersion },
          }),
        },
      ],
    }),
  )
  created = Option.some(deployed.id)
  const app = encodeURIComponent(deployed.id)
  const executor = yield* Executor.pipe(Effect.provideContext(yield* Layer.build(executorLayer)))
  const database = yield* Database
  /** One account: its own profile, its own Executor account, its own Connection row. */
  const connect = Effect.fn('ThreadProof.account')(function* (who: string) {
    const profile = yield* HttpClientResponse.schemaBodyJson(Profile)(
      yield* executorRequest(`/apps/${app}/profiles`, {
        name: 'Proof Accounts',
        accounts: {},
        idempotencyKey: NodeCrypto.randomUUID(),
      }),
    )
    const authorization = yield* HttpClientResponse.schemaBodyJson(Authorization)(
      yield* executorRequest(`/apps/${app}/connections`, {
        requirement: 'service',
        profile: profile.id,
      }),
    )
    const account = yield* HttpClientResponse.schemaBodyJson(Account)(
      yield* executorRequest(
        `/connections/${encodeURIComponent(authorization.id)}/submit`,
        // A stand-in key: the proof service checks nothing but that one was given.
        { method: 'key', label: 'Proof Accounts', fields: { who, token: Redacted.value(key) } },
      ),
    )
    const references = ExecutorReferences.cases.Authorized.make({
      app: deployed.id,
      profile: profile.id,
      owner,
      service,
      appOwnership: 'Shared',
      account: account.id,
    })
    expect(ExecutorStatus.guards.Ready(yield* executor.status(references))).toBe(true)
    const identity = yield* executor.identity(references)
    if (Option.isNone(identity))
      return yield* Effect.sync(() => expect.fail('Executor did not say who the account is'))
    const now = yield* Clock.currentTimeMillis
    const id = ConnectionId.make(NodeCrypto.randomUUID())
    yield* database.run(
      database.insert(connections).values({
        id,
        personId: fixture.personId,
        companyId: null,
        service,
        serviceName: 'Proof Accounts',
        name: null,
        identity: identity.value,
        references: yield* encodeReferences(references),
        status: 'ready',
        reason: null,
        createdAt: now,
        updatedAt: now,
      }),
    )
    return { id, references, identity: identity.value }
  })
  const first = yield* connect(whose[0])
  const second = yield* connect(whose[1])
  /** Observe real storage through Executor: every record says which account saved it. */
  const records = Effect.fn('ThreadProof.accountRecords')(function* (subject: string) {
    const result = yield* executor.call({
      references: first.references,
      tool: 'records',
      input: { subject },
    })
    if (!ExecutorCallOutcome.guards.Completed(result))
      return yield* Effect.sync(() => expect.fail('Executor record read did not complete'))
    return (yield* decodeAccountRecords(result.value)).map((record) => ({
      subject: record.subject,
      by: record.by,
    }))
  })
  return { first, second, records }
})
