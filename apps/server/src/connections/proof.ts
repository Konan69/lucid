import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { ConnectionId, ServiceId, ServiceUnavailable } from '@vivid/contracts'
import { Clock, Config, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { Database } from '../database/client.ts'
import type { ChainFixture } from '../runtime/chains.ts'
import {
  ExecutorAppOwnership,
  Executor,
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorOwnerId,
  ExecutorBinding,
  ExecutorReferences,
  ExecutorCallOutcome,
  ExecutorStatus,
  executorLayer,
  installationCaller,
} from './executor.ts'
import { appsVersion } from './framework.ts'
import { encodeReferences } from './records.ts'
import { connections } from './tables.ts'

/** Port the retained record mechanism from Executor packages/sdk/test/app-data.test.ts `source`.
 * Each deployment has its own real SQLite store. Vivid names replace the reference's names, and
 * mutation outputs omit row handles; polling still uses stable provider ids behind the server.
 * This service is a real Executor fixture, not evidence of a third-party OAuth connection.
 */
const source = `import { query, mutation, defineApp, object, string, router } from "apps";
export default defineApp({}, { tools: router({
  queries: router({ records: query({ description: "Read saved proof records in creation order", input: object({}) }, async ({ sql }) => sql.exec("SELECT id, subject FROM records ORDER BY rowid").toArray()) }),
  mutations: router({ save: mutation({ description: "Save a proof record", input: object({ subject: string() }) }, async ({ sql }, value) => { sql.exec("INSERT INTO records (id, subject) VALUES (?, ?)", crypto.randomUUID(), value.subject); return { saved: true, subject: value.subject }; }) })
}) });`

const Deployment = Schema.Struct({ id: ExecutorAppId })
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

/** HostedApps.deploy returns App directly. Allocate an isolated real service/app before linking
 * it to this fixture's Person. Cleanup
 * is installed before deployment; provider resources are removed before the Person cascades.
 * Only private test rows are inserted; credentials remain exclusively inside Executor.
 */
export const proofConnection = Effect.fn('ThreadProof.connection')(function* (
  fixture: Pick<ChainFixture, 'personId'>,
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
      files: [
        { path: 'index.ts', content: source },
        {
          path: 'migrations/0001_records.sql',
          content: 'CREATE TABLE records (id TEXT PRIMARY KEY, subject TEXT NOT NULL);',
        },
        {
          path: 'package.json',
          content: JSON.stringify({
            private: true,
            type: 'module',
            dependencies: { apps: appsVersion },
          }),
        },
      ],
    }),
  )
  created = Option.some(deployed.id)
  const references = ExecutorReferences.cases.Public.make({
    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
    app: deployed.id,
    binding: ExecutorBinding.cases.Public.make({}),
    owner,
    service: ServiceId.make('proof-records'),
  })
  const context = yield* Layer.build(executorLayer)
  const executor = yield* Executor.pipe(Effect.provideContext(context))
  expect((yield* executor.as(installationCaller).status(references))._tag).toBe('Ready')
  const tools = yield* executor.as(installationCaller).tools(references)
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
      executorApp: references.app,
      references: yield* encodeReferences(references),
      status: 'ready',
      reason: null,
      createdAt: now,
      updatedAt: now,
    }),
  )
  /** Observe real storage through Executor, not Vivid's action receipt or a copied mock value. */
  const records = Effect.fn('ThreadProof.records')(function* () {
    const result = yield* executor
      .as(installationCaller)
      .call({ references, tool: 'queries.records', input: {} })
    if (!ExecutorCallOutcome.guards.Completed(result))
      return expect.fail('Executor record read did not complete')
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
 * each app has its own data: that field also proves the account a call went
 * through. A package manifest names the `apps` version the hosted build requires, and the tools
 * sit in a router under `tools`. Both proof apps use beta.92 SQLite handlers and retain their
 * existing tool paths.
 */
const accountsSource = `import { query, mutation, defineApp, defineProvider, secrets, plain, json, object, string, router } from "apps";
const service = defineProvider({ name: "Proof Accounts", auth: { key: secrets({ label: "Key", fields: object({ who: plain(string()), token: string() }) }) }, async health({ account }) { return { accountInfo: { email: account.fields.who } }; } });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ({ user }) => {
  if (user === undefined) return { tools: router({}) };
  const [account] = user.accounts.service;
  if (account === undefined) return { tools: router({}) };
  return { tools: router({
    records: query({ description: "Read the saved proof records that have one subject", input: object({ subject: string() }), output: json() }, async ({ sql }, { subject }) => sql.exec('SELECT subject, "by" FROM records WHERE subject = ? LIMIT 50', subject).toArray()),
    save: mutation({ description: "Save a proof record through this account", input: object({ subject: string() }), output: json() }, async ({ sql }, { subject }) => { sql.exec('INSERT INTO records (subject, "by") VALUES (?, ?)', subject, account.fields.who); return { saved: true, subject }; })
  }) };
});`

const Authorization = Schema.Struct({ id: Schema.NonEmptyString })
const Account = Schema.Struct({ id: ExecutorAccountId })
export const AccountRecords = Schema.Array(
  Schema.Struct({ subject: Schema.String, by: Schema.String }),
)
const decodeAccountRecords = Schema.decodeUnknownEffect(AccountRecords)

/**
 * Two real accounts on separate real Executor apps, linked to this fixture's Person as two Connections
 * of one service. Each is connected the way a keyed service is (a dedicated app, a targeted connection
 * request, a submitted key), so each Connection holds its own Executor account. Who each account
 * is comes from Executor itself, through the adapter (`Executor.identity`), and is written on the
 * row as the store writes it once a Connection is ready. The rows are inserted because the proof
 * service is not in the catalogue, which is the only way a Person begins one; everything read
 * afterwards (names, discovery, approval, the call) is the product's own path.
 */
export const proofAccounts = Effect.fn('ThreadProof.accounts')(function* (
  fixture: Pick<ChainFixture, 'personId'>,
  whose: readonly [string, string],
) {
  const endpoint = yield* hostedEndpoint()
  const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
  const http = yield* HttpClient.HttpClient
  const owner = ExecutorOwnerId.make(`accounts-proof-${NodeCrypto.randomUUID()}`)
  const service = ServiceId.make('proof-accounts')
  const executor = yield* Executor.pipe(Effect.provideContext(yield* Layer.build(executorLayer)))
  const database = yield* Database
  /** One account owns its app, its Executor account, and its Connection row. */
  const connect = Effect.fn('ThreadProof.account')(function* (who: string) {
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
            path: 'migrations/0001_records.sql',
            content: 'CREATE TABLE records (subject TEXT NOT NULL, "by" TEXT NOT NULL);',
          },
          {
            path: 'package.json',
            content: JSON.stringify({
              name: 'vivid-proof-accounts',
              private: true,
              type: 'module',
              dependencies: { apps: appsVersion },
            }),
          },
        ],
      }),
    )
    created = Option.some(deployed.id)
    const app = encodeURIComponent(deployed.id)
    const authorization = yield* HttpClientResponse.schemaBodyJson(Authorization)(
      yield* executorRequest(`/apps/${app}/accounts/user/service/connections`, {}),
    )
    const account = yield* HttpClientResponse.schemaBodyJson(Account)(
      yield* executorRequest(
        `/connections/${encodeURIComponent(authorization.id)}/submit`,
        // A stand-in key: the proof service checks nothing but that one was given.
        { method: 'key', label: 'Proof Accounts', fields: { who, token: Redacted.value(key) } },
      ),
    )
    const references = ExecutorReferences.cases.Authorized.make({
      appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
      app: deployed.id,
      binding: ExecutorBinding.cases.Account.make({ requirement: 'service', scope: 'user' }),
      owner,
      service,
      account: account.id,
    })
    expect(
      ExecutorStatus.guards.Ready(yield* executor.as(installationCaller).status(references)),
    ).toBe(true)
    const identity = yield* executor.as(installationCaller).identity(references)
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
        executorApp: references.app,
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
    const pages = yield* Effect.forEach(
      [first, second],
      Effect.fnUntraced(function* (connection) {
        const result = yield* executor.as(installationCaller).call({
          references: connection.references,
          tool: 'records',
          input: { subject },
        })
        if (!ExecutorCallOutcome.guards.Completed(result))
          return expect.fail('Executor record read did not complete')
        return yield* decodeAccountRecords(result.value)
      }),
    )
    return pages.flat().map((record) => ({ subject: record.subject, by: record.by }))
  })
  return { first, second, records }
})
