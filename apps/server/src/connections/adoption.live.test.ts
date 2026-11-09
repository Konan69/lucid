import * as NodeHttp from 'node:http'
import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, ServiceId, WatchId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import {
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
} from 'effect'
import { HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from 'effect/http'
import * as NetAddress from 'effect/net/NetAddress'
import type { Actor } from '../auth/access.ts'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ExecutorEvents, executorEventsLayer } from '../watches/events.ts'
import { secretFor, verify } from '../watches/signature.ts'
import { watches } from '../watches/tables.ts'
import {
  Executor,
  ExecutorAppOwnership,
  ExecutorCallOutcome,
  ExecutorCaller,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorStep,
  executorLayer,
  installationCaller,
} from './executor.ts'
import { ExecutorAdoption, executorAdoptionLayer } from './adopter.ts'
import { ExecutorMembers, executorMembersLayer, operationsOf } from './members.ts'
import { adoptConnections } from './migration.ts'
import { madeFiles } from './made.ts'
import { decodeRow, encodeReferences } from './records.ts'
import { removeConnection } from './removal.ts'
import { connections } from './tables.ts'
import { connectionTestLayer, fixture } from './testing.ts'

const decodeCallbackJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))
const decodeVerification = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal('verification'), challenge: Schema.String }),
)

const enabled = process.env['VIVID_LIVE_EXECUTOR_ADOPTION'] === '1'
const settings = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    GOOGLE_CLIENT_ID: 'isolated-test-client',
    GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
    VIVID_EXECUTOR_URL: process.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_KEY: process.env['VIVID_TEST_EXECUTOR_KEY'],
    VIVID_EXECUTOR_ORGANIZATION: process.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
    VIVID_EXECUTOR_OWNER_EMAIL: process.env['VIVID_TEST_EXECUTOR_OWNER_EMAIL'],
    VIVID_EXECUTOR_OWNER_PASSWORD: process.env['VIVID_TEST_EXECUTOR_OWNER_PASSWORD'],
    VIVID_EXECUTOR_SEAL_KEY: process.env['VIVID_TEST_EXECUTOR_SEAL_KEY'],
  }),
)

/** All successful calls use the real transport. This one-shot defect simulates process loss
 * after deployment but before the first app link, without fabricating an Executor response. */
const liveLayers = (crash: Ref.Ref<boolean>) => {
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return HttpClient.mapRequestEffect(client, (request) =>
        Effect.gen(function* () {
          if (
            request.method === 'PUT' &&
            request.url.includes('/accounts/app/') &&
            (yield* Ref.getAndSet(crash, false))
          )
            return yield* Effect.die('Injected crash before app link')
          return request
        }),
      )
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici))
  return Layer.mergeAll(
    executorLayer,
    executorMembersLayer,
    executorAdoptionLayer,
    executorEventsLayer,
  ).pipe(Layer.provideMerge(transport), Layer.provideMerge(settings))
}

/** These are beta.23's three generated factory shapes. Synthetic secrets exercise the real
 * personal-account/link boundary without asking Google, GitHub or Grain for another sign-in.
 * Production provider files and their credentials are not edited by the source bridge. */
const credential = (kind: 'Google' | 'Catalogue MCP' | 'URL MCP') => {
  const requirement = kind === 'Google' ? 'google' : 'service'
  const tool =
    'read: query({ description: "Read the existing credential", input: object({}), output: json() }, async () => ({ marker: account.fields.token }))'
  const factory =
    kind === 'URL MCP'
      ? `async ({ user, signal, cache }) => ({ tools: await accountRouter(user?.accounts.service ?? [], (account) => router({ ${tool} }), { signal }) })`
      : `async ({ user, signal, cache }) => { if (user === undefined) return { tools: router({}) }; const [account] = user.accounts.${requirement}; if (account === undefined) return { tools: router({}) }; return { tools: router({ ${tool} }) }; }`
  return {
    name: `${kind} factory proof`,
    files: [
      {
        path: 'index.ts',
        content: `import { query, defineApp, defineProvider, secrets, object, string, json, router, accountRouter } from "apps";
const provider = defineProvider({ name: "Adopt proof", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { ${requirement}: provider.many() } } }, ${factory});`,
      },
    ],
  }
}
const publicApp = {
  name: 'Public proof',
  files: [
    {
      path: 'index.ts',
      content: `import { query, defineApp, object, json, router } from "apps";
export default defineApp({}, { tools: router({ read: query({ description: "Read public proof", input: object({}), output: json() }, async () => ({ marker: "public-marker" })) }) });`,
    },
  ],
}
const stored = {
  name: 'Stored proof',
  files: [
    { path: 'migrations/0001_proof.sql', content: 'CREATE TABLE proof (value TEXT NOT NULL);' },
    {
      path: 'index.ts',
      content: `import { query, mutation, defineApp, event, object, string, json, router } from "apps";
export default defineApp({ events: { changed: event({ description: "A proof changed", payload: object({ marker: string() }) }) } }, { tools: router({
write: mutation({ description: "Store proof", input: object({}), output: json() }, async (ctx) => { ctx.sql.exec("INSERT INTO proof VALUES (?)", "preserved-data"); return { ok: true }; }),
read: query({ description: "Read stored proof", input: object({}), output: json() }, async (ctx) => ctx.sql.exec("SELECT value FROM proof").toArray()),
ring: mutation({ description: "Emit proof event", input: object({}), output: json() }, async (ctx) => { ctx.events.emit("changed", { marker: "moved-watch" }); return { ok: true }; }) }) });`,
    },
  ],
}

/** Public API inspection never opens Executor's database, volume or app SQL outside a tool. */
const foreignStatus = Effect.fn('AdoptionProof.foreignStatus')(function* (path: string) {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient)
  const url = yield* Config.String('VIVID_EXECUTOR_URL')
  const organization = yield* Config.String('VIVID_EXECUTOR_ORGANIZATION')
  const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
  return (yield* http.execute(
    HttpClientRequest.get(`${url}/api/organizations/${organization}${path}`).pipe(
      HttpClientRequest.bearerToken(key),
    ),
  )).status
})
const row = Effect.fn('AdoptionProof.row')(function* (id: ConnectionId) {
  const database = yield* Database
  const [raw] = yield* database.run(
    database.select().from(connections).where(eq(connections.id, id)),
  )
  if (raw === undefined) return expect.fail('Expected persisted Connection')
  return yield* decodeRow(raw)
})

/** Cleanup uses the current principal and fails the proof if any owned resource cannot be removed. */
const legacy = Effect.fn('AdoptionProof.legacy')(function* (
  actor: Actor,
  request: typeof publicApp,
) {
  const database = yield* Database
  const owner = (yield* Executor).as(installationCaller)
  const id = ConnectionId.make(crypto.randomUUID())
  const step = yield* owner.make({
    connectionId: id,
    service: ServiceId.make(`made:adoption-${id}`),
    owner: ExecutorOwnerId.make(`p-${actor.person.id}`),
    subject: actor.person.id,
    label: 'Adoption proof',
    returnAddress: 'https://vivid.example.test/api/connections/return',
    files: madeFiles(request),
  })
  const references = ExecutorStep.guards.EnterKey(step)
    ? yield* owner.complete({
        references: step.references,
        fields: { token: Redacted.make('retained-marker') },
      })
    : step.references
  let inserted = false
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (!inserted) return yield* owner.remove(references)
      const [raw] = yield* database.run(
        database.select().from(connections).where(eq(connections.id, id)),
      )
      if (raw !== undefined) yield* removeConnection(yield* decodeRow(raw))
    }).pipe(
      Effect.result,
      Effect.map((result) => expect(Result.isSuccess(result)).toBe(true)),
    ),
  )
  yield* database.run(
    database.insert(connections).values({
      id,
      personId: actor.person.id,
      companyId: null,
      service: references.service,
      serviceName: request.name,
      executorApp: references.app,
      references: yield* encodeReferences(references),
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
  inserted = true
  return id
})

/** Callback receipts are signature-checked and awaited by signal. No sleeps or delivery polling. */
const receiver = Effect.fn('AdoptionProof.receiver')(function* (secret: Redacted.Redacted) {
  const messages = yield* Queue.unbounded<Schema.Json>()
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* request.text
    const id = request.headers['webhook-id']
    const timestamp = request.headers['webhook-timestamp']
    const signatures = request.headers['webhook-signature']
    if (
      id === undefined ||
      timestamp === undefined ||
      signatures === undefined ||
      !verify(secret, { id, timestamp, signatures, body }, Date.now())
    )
      return HttpServerResponse.empty({ status: 401 })
    const decoded = yield* decodeCallbackJson(body)
    const verification = decodeVerification(decoded)
    if (Option.isSome(verification))
      return yield* HttpServerResponse.json({ challenge: verification.value.challenge })
    yield* Queue.offer(messages, decoded)
    return HttpServerResponse.empty({ status: 204 })
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 })))
  yield* server.serve(handler)
  if (!NetAddress.isInetAddress(server.address)) return expect.fail('Expected TCP callback')
  const address = yield* Effect.fromResult(NetAddress.toUrl(server.address))
  return { messages, url: new URL('/watch', address).href }
})

/** A Watch is active under the installation key before the pass takes its Connection. */
const existingWatch = Effect.fn('AdoptionProof.existingWatch')(function* (id: ConnectionId) {
  const database = yield* Database
  const config = yield* ServerConfig
  const watchId = WatchId.make(crypto.randomUUID())
  const secret = secretFor(config.AUTH_SECRET, watchId)
  const callback = yield* receiver(secret)
  const current = yield* row(id)
  const owner = (yield* Executor).as(installationCaller)
  expect(yield* owner.call({ references: current.references, tool: 'write', input: {} })).toEqual(
    ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }),
  )
  if (ExecutorReferences.guards.ReconnectRequired(current.references))
    return expect.fail('Expected live app')
  const subscription = {
    name: `${yield* owner.appSlug(current.references.app)}.changed`,
    arguments: {},
    url: callback.url,
  }
  const grant = yield* (yield* ExecutorEvents).subscribe(installationCaller, {
    ...subscription,
    secret,
    ttlMs: 60_000,
  })
  yield* database.run(
    database.insert(watches).values({
      id: watchId,
      personId: current.personId,
      companyId: null,
      name: 'Existing watch',
      connectionId: id,
      event: 'changed',
      subscribedName: subscription.name,
      arguments: {},
      instruction: 'Keep this proof',
      callbackUrl: callback.url,
      state: 'Active',
      refreshBefore: grant.refreshBefore.getTime(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
  return { callback, subscription }
})

/** The same pass is re-entered after the injected crash. Installation reads must still succeed. */
const crashAndResume = Effect.fn('AdoptionProof.crashAndResume')(function* (
  id: ConnectionId,
  crash: Ref.Ref<boolean>,
) {
  yield* Ref.set(crash, true)
  expect(Exit.isFailure(yield* adoptConnections().pipe(Effect.exit))).toBe(true)
  expect(yield* Ref.get(crash)).toBe(false)
  const interrupted = yield* row(id)
  expect(interrupted.executorPrincipal).toBe('installation')
  expect(ExecutorReferences.guards.Adopting(interrupted.references)).toBe(true)
  if (!ExecutorReferences.guards.Adopting(interrupted.references))
    return expect.fail('Expected stored adoption bridge')
  const deployed = yield* (yield* ExecutorAdoption).source(interrupted.references.app)
  const index = deployed.find((file) => file.path === 'index.ts')
  if (index === undefined) return expect.fail('Expected deployed index')
  expect(index.content).toContain('vivid-adoption:')
  expect(
    yield* (yield* operationsOf(interrupted)).call({
      references: interrupted.references,
      tool: 'read',
      input: {},
    }),
  ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: { marker: 'retained-marker' } }))
  expect(yield* adoptConnections()).toBe(false)
})

/** Execution and retirement use the persisted principal, not a test-selected owner fallback. */
const prove = Effect.fn('AdoptionProof.prove')(function* (input: {
  actor: Actor
  caller: ExecutorCaller
  other: ExecutorCaller
  request: typeof publicApp
  crash: Ref.Ref<boolean>
}) {
  const id = yield* legacy(input.actor, input.request)
  const watch =
    input.request === stored
      ? Option.some(yield* existingWatch(id))
      : Option.none<Effect.Success<ReturnType<typeof existingWatch>>>()
  if (input.request === publicApp || input.request === stored)
    expect(yield* adoptConnections()).toBe(false)
  else yield* crashAndResume(id, input.crash)
  const moved = yield* row(id)
  expect(moved.executorPrincipal).toBe('adopted')
  if (!ExecutorReferences.isAnyOf(['Public', 'Authorized'])(moved.references))
    return expect.fail('Expected adopted live reference')
  const ownership = moved.references.appOwnership
  if (!ExecutorAppOwnership.guards.Adopted(ownership))
    return expect.fail('Expected persisted group')
  const executor = yield* Executor
  for (const caller of [input.other, installationCaller]) {
    expect(
      Result.isFailure(yield* executor.as(caller).tools(moved.references).pipe(Effect.result)),
    ).toBe(true)
    expect(
      Result.isFailure(
        yield* executor
          .as(caller)
          .call({ references: moved.references, tool: 'read', input: {} })
          .pipe(Effect.result),
      ),
    ).toBe(true)
  }
  const operations = yield* operationsOf(moved)
  const value =
    input.request === stored
      ? [{ value: 'preserved-data' }]
      : { marker: input.request === publicApp ? 'public-marker' : 'retained-marker' }
  expect(yield* operations.call({ references: moved.references, tool: 'read', input: {} })).toEqual(
    ExecutorCallOutcome.cases.Completed.make({ value }),
  )
  if (input.request === stored) {
    const files = yield* operations.readMade(moved.references.app)
    yield* operations.reviseMade(
      moved.references.app,
      madeFiles({ name: input.request.name, files }),
    )
    expect(
      yield* operations.call({ references: moved.references, tool: 'read', input: {} }),
    ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value }))
  }
  if (Option.isSome(watch)) {
    expect(
      yield* operations.call({ references: moved.references, tool: 'ring', input: {} }),
    ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }))
    expect(JSON.stringify(yield* Queue.take(watch.value.callback.messages))).toContain(
      'moved-watch',
    )
    yield* (yield* ExecutorEvents).unsubscribe(input.caller, watch.value.subscription)
  }
  // Re-running after all post-commit cleanup converges without redeploying or re-adding the owner.
  expect(yield* adoptConnections()).toBe(false)
  yield* removeConnection(yield* row(id))
  const adopter = yield* ExecutorAdoption
  yield* adopter.remove(moved.references)
  yield* adopter.removeGroup(ownership.group)
  expect([403, 404]).toContain(yield* foreignStatus(`/apps/${moved.references.app}`))
  expect([403, 404]).toContain(yield* foreignStatus(`/apps/${moved.references.app}/accounts/app`))
  expect([403, 404]).toContain(yield* foreignStatus(`/groups/${ownership.group}`))
  if (ExecutorReferences.guards.Authorized(moved.references))
    expect([403, 404]).toContain(yield* foreignStatus(`/accounts/${moved.references.account}`))
})

describe.skipIf(!enabled || !testDatabaseConfigured)('Executor adoption', () => {
  layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
    it.effect(
      'resumes the pass after deploy, preserves data and an existing Watch, isolates and removes every adopted resource',
      () =>
        Effect.gen(function* () {
          const actors = yield* fixture()
          const crash = yield* Ref.make(false)
          const context = yield* Layer.build(liveLayers(crash))
          yield* Effect.gen(function* () {
            const members = yield* ExecutorMembers
            const caller = yield* members.caller({
              principal: 'member',
              personId: actors.personalActor.person.id,
            })
            const other = yield* members.caller({
              principal: 'member',
              personId: actors.memberActor.person.id,
            })
            for (const request of [
              credential('Google'),
              credential('Catalogue MCP'),
              credential('URL MCP'),
              publicApp,
              stored,
            ])
              yield* prove({ actor: actors.personalActor, caller, other, request, crash })
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      { timeout: 240_000 },
    )
  })
})
