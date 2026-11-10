import * as NodeHttp from 'node:http'
import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, ConnectionStep, ServiceId, WatchId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import {
  Config,
  ConfigProvider,
  Effect,
  Deferred,
  Fiber,
  Exit,
  Layer,
  Match,
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
  ExecutorAppId,
  ExecutorAccountId,
  ExecutorAuthorizationId,
  ExecutorBinding,
  ExecutorRetired,
  AdoptionFinalization,
  ExecutorCallOutcome,
  ExecutorCaller,
  ExecutorOwnerId,
  ExecutorReferences,
  retirementOf,
  ExecutorStep,
  executorLayer,
  installationCaller,
} from './executor.ts'
import { ExecutorAdoption, executorAdoptionLayer } from './adopter.ts'
import { ExecutorMembers, executorMembersLayer, operationsOf, watchPrincipal } from './members.ts'
import { adoptConnections } from './migration.ts'
import { adoptionFiles } from './adoption.ts'
import { madeFiles } from './made.ts'
import { decodeRow, encodeReferences } from './records.ts'
import { removeConnection } from './removal.ts'
import { connections } from './tables.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { makeWatchedApps } from '../watches/apps.ts'
import { connectionTestLayer, fixture } from './testing.ts'

/** Exact read-only captured file arrays. Provider endpoints/auth are altered only in the call fixture below. */
const gmailWorkspace = {
  files: [
    {
      path: 'index.ts',
      content:
        'import { defineApp } from "apps";\nimport { liveOpenapiRouter } from "apps/openapi";\nimport { provider } from "./provider.ts";\nexport default defineApp({ accounts: { google: provider } }, async ({ accounts, cache, fetch, signal }) => ({ tools: liveOpenapiRouter({ cache, fetch, signal, source: { url: "https://integrations.sh/specs/google/google-gmail.json" }, allowedOrigin: "https://gmail.googleapis.com", securitySchemes: {"googleOAuth2":{"type":"oauth2","flows":{"authorizationCode":{"authorizationUrl":"https://accounts.google.com/o/oauth2/v2/auth","tokenUrl":"https://oauth2.googleapis.com/token","scopes":{"openid":"","email":"","profile":"","https://mail.google.com/":"","https://www.googleapis.com/auth/gmail.settings.basic":""}}}}}, methods: {}, oauth: ["googleOAuth2"], account: accounts.google }) }));\n',
    },
    {
      path: 'package.json',
      content:
        '{"name":"vivid-google-gmail","private":true,"type":"module","dependencies":{"apps":"0.0.1-beta.22"}}',
    },
    {
      path: 'provider.ts',
      content:
        'import { decodeJson, defineProvider, oauth2, object, string } from "apps";\nexport const provider = defineProvider({ name: "Gmail", hosts: ["gmail.googleapis.com","openidconnect.googleapis.com"], auth: { googleOAuth2: oauth2({"discover":"https://accounts.google.com","scopes":["openid","email","profile","https://mail.google.com/","https://www.googleapis.com/auth/gmail.settings.basic"],"resource":null,"authorizationParams":{"access_type":"offline","prompt":"consent"}}) }, async health({ account, fetch, signal }) { const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { signal, headers: { Authorization: "Bearer " + account.fields.access_token } }); const user = await decodeJson(response, object({ email: string() })); return { accountInfo: { email: user.email } }; } });\n',
    },
  ],
}
const calendarWorkspace = {
  files: [
    {
      path: 'index.ts',
      content:
        'import { defineApp } from "apps";\nimport { liveOpenapiRouter } from "apps/openapi";\nimport { provider } from "./provider.ts";\nexport default defineApp({ accounts: { google: provider } }, async ({ accounts, cache, fetch, signal }) => ({ tools: liveOpenapiRouter({ cache, fetch, signal, source: { url: "https://integrations.sh/specs/google/google-calendar.json" }, allowedOrigin: "https://www.googleapis.com", securitySchemes: {"googleOAuth2":{"type":"oauth2","flows":{"authorizationCode":{"authorizationUrl":"https://accounts.google.com/o/oauth2/v2/auth","tokenUrl":"https://oauth2.googleapis.com/token","scopes":{"openid":"","email":"","profile":"","https://www.googleapis.com/auth/calendar":""}}}}}, methods: {}, oauth: ["googleOAuth2"], account: accounts.google }) }));\n',
    },
    {
      path: 'package.json',
      content:
        '{"name":"vivid-google-calendar","private":true,"type":"module","dependencies":{"apps":"0.0.1-beta.22"}}',
    },
    {
      path: 'provider.ts',
      content:
        'import { decodeJson, defineProvider, oauth2, object, string } from "apps";\nexport const provider = defineProvider({ name: "Google Calendar", hosts: ["www.googleapis.com","openidconnect.googleapis.com"], auth: { googleOAuth2: oauth2({"discover":"https://accounts.google.com","scopes":["openid","email","profile","https://www.googleapis.com/auth/calendar"],"resource":null,"authorizationParams":{"access_type":"offline","prompt":"consent"}}) }, async health({ account, fetch, signal }) { const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { signal, headers: { Authorization: "Bearer " + account.fields.access_token } }); const user = await decodeJson(response, object({ email: string() })); return { accountInfo: { email: user.email } }; } });\n',
    },
  ],
}
const githubWorkspace = {
  files: [
    {
      path: 'index.ts',
      content:
        'import { defineApp, defineProvider, secrets, object, string } from "apps";\nimport { mcpRouter } from "apps/mcp";\nconst service = defineProvider({ name: "GitHub", hosts: ["api.githubcopilot.com"], auth: { pat: secrets({ label: "Personal access token", fields: object({ token: string() }) }) } });\nexport default defineApp({ accounts: { service } }, async ({ accounts, signal, cache }) => ({ tools: await mcpRouter({ url: "https://api.githubcopilot.com/mcp/", headers: { ["Authorization"]: "Bearer " + accounts.service.fields.token }, accountId: accounts.service.id, cache: cache.forAccount(accounts.service), signal }) }));\n',
    },
    {
      path: 'package.json',
      content:
        '{"name":"vivid-keyed-mcp","private":true,"type":"module","dependencies":{"apps":"0.0.1-beta.19","@modelcontextprotocol/sdk":"1.30.0"}}',
    },
  ],
}

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
    VIVID_EXECUTOR_PUBLIC_URL: process.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_KEY: process.env['VIVID_TEST_EXECUTOR_KEY'],
    VIVID_EXECUTOR_ORGANIZATION: process.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
    VIVID_EXECUTOR_OWNER_EMAIL: process.env['VIVID_TEST_EXECUTOR_OWNER_EMAIL'],
    VIVID_EXECUTOR_OWNER_PASSWORD: process.env['VIVID_TEST_EXECUTOR_OWNER_PASSWORD'],
    VIVID_EXECUTOR_SEAL_KEY: process.env['VIVID_TEST_EXECUTOR_SEAL_KEY'],
  }),
)

/** All successful calls use the real transport. This one-shot defect simulates process loss
 * after deployment but before the first app link, without fabricating an Executor response. */
type Receipt = {
  readonly method: string
  readonly path: string
  readonly principal: 'owner' | 'member'
}
const liveLayers = (
  crash: Ref.Ref<Effect.Effect<void>>,
  receipts: Ref.Ref<ReadonlyArray<Receipt>>,
) => {
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
      return HttpClient.transform(client, (response, request) =>
        Effect.gen(function* () {
          const principal =
            request.headers['authorization'] === `Bearer ${Redacted.value(key)}`
              ? ('owner' as const)
              : ('member' as const)
          yield* Ref.update(receipts, (seen) => [
            ...seen,
            { method: request.method, path: new URL(request.url).pathname, principal },
          ])
          if (
            request.url.includes('/accounts/app/') &&
            (request.method === 'PUT' || (request.method === 'GET' && principal === 'member'))
          )
            yield* Ref.getAndSet(crash, Effect.void).pipe(Effect.flatMap((hook) => hook))
          return yield* response
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
    'read: query({ description: "Read the existing credential", input: object({}), output: json() }, async () => ({ marker: account.fields.token })), ring: mutation({ description: "Emit credential event", input: object({}), output: json() }, async (ctx) => { ctx.events.emit("changed", { marker: "moved-watch" }); return { ok: true }; })'
  const factory =
    kind === 'URL MCP'
      ? `async ({ user, signal, cache }) => ({ tools: await accountRouter(user?.accounts.service ?? [], (account) => router({ ${tool} }), { signal }) })`
      : `async ({ user, signal, cache }) => { if (user === undefined) return { tools: router({}) }; const [account] = user.accounts.${requirement}; if (account === undefined) return { tools: router({}) }; return { tools: router({ ${tool} }) }; }`
  return {
    name: `${kind} factory proof`,
    files: [
      {
        path: 'index.ts',
        content: `import { query, mutation, event, defineApp, defineProvider, secrets, object, string, json, router, accountRouter } from "apps";
const provider = defineProvider({ name: "Adopt proof", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { ${requirement}: provider.many() } }, events: { changed: event({ description: "A credential event", payload: object({ marker: string() }) }) } }, ${factory});`,
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
  mode: 'Complete' | 'Pending',
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
  const references =
    ExecutorStep.guards.EnterKey(step) && mode === 'Complete'
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
      status: ExecutorReferences.isAnyOf(['Public', 'Authorized'])(references)
        ? 'ready'
        : 'needs-authorization',
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

/** Resolve the real Watch authority from persisted principal before subscribing. */
const watchAt = Effect.fn('AdoptionProof.watchAt')(function* (
  id: ConnectionId,
  resolved: Effect.Effect<void>,
) {
  const database = yield* Database
  const config = yield* ServerConfig
  const watchId = WatchId.make(crypto.randomUUID())
  const secret = secretFor(config.AUTH_SECRET, watchId)
  const callback = yield* receiver(secret)
  const current = yield* row(id)
  const executor = yield* Executor
  const caller = yield* makeWatchedApps(database, executor, yield* ExecutorMembers).callerOf(id)
  const operations = executor.as(caller)
  yield* resolved
  if (ExecutorReferences.guards.ReconnectRequired(current.references))
    return expect.fail('Expected live app')
  const subscription = {
    name: `${yield* operations.appSlug(current.references.app)}.changed`,
    arguments: {},
    url: callback.url,
  }
  const grant = yield* (yield* ExecutorEvents).subscribe(caller, {
    ...subscription,
    secret,
    ttlMs: 60_000,
  })
  yield* database.run(
    database.insert(watches).values({
      id: watchId,
      personId: current.personId,
      companyId: null,
      name: `Proof ${watchId}`,
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
  return { callback, subscription, caller }
})

/** The same pass is re-entered after the injected crash. Installation reads must still succeed. */
const crashAndResume = Effect.fn('AdoptionProof.crashAndResume')(function* (
  id: ConnectionId,
  crash: Ref.Ref<Effect.Effect<void>>,
) {
  const database = yield* Database
  yield* database.run(
    database
      .update(connections)
      .set({ updatedAt: Date.now() + 60_000 })
      .where(eq(connections.id, id)),
  )
  const attempted = yield* Deferred.make<void>()
  yield* Ref.set(
    crash,
    Deferred.succeed(attempted, undefined).pipe(
      Effect.andThen(Effect.die('Injected crash before app link')),
    ),
  )
  expect(Exit.isFailure(yield* adoptConnections().pipe(Effect.exit))).toBe(true)
  expect(yield* Deferred.isDone(attempted)).toBe(true)
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
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const resolved = yield* Deferred.make<void>()
  yield* Ref.set(
    crash,
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
  )
  const move = yield* adoptConnections().pipe(Effect.forkChild)
  yield* Effect.raceFirst(
    Deferred.await(entered),
    Fiber.join(move).pipe(Effect.andThen(Effect.die('Move ended before the link barrier'))),
  )
  const created = yield* watchAt(id, Deferred.succeed(resolved, undefined)).pipe(Effect.forkChild)
  yield* Deferred.await(resolved)
  yield* Deferred.succeed(release, undefined)
  expect(yield* Fiber.join(move)).toBe(false)
  const during = yield* Fiber.join(created)
  expect((yield* row(id)).updatedAt).toBeGreaterThan(interrupted.updatedAt)
  expect(ExecutorCaller.guards.Installation(during.caller)).toBe(true)

  return during
})

/** Delivery goes through the event authority selected by the persisted principal. */
const delivered = Effect.fn('AdoptionProof.delivered')(function* (
  id: ConnectionId,
  watch: Effect.Success<ReturnType<typeof watchAt>>,
) {
  const current = yield* row(id)
  expect(
    yield* (yield* operationsOf(current)).call({
      references: current.references,
      tool: 'ring',
      input: {},
    }),
  ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }))
  expect(JSON.stringify(yield* Queue.take(watch.callback.messages))).toContain('moved-watch')
  const caller = yield* (yield* ExecutorMembers).caller({
    principal: watchPrincipal(current.executorPrincipal),
    personId: current.personId,
  })
  yield* (yield* ExecutorEvents).unsubscribe(caller, watch.subscription)
})

/** Force the real Resume path to probe an otherwise-valid adopted credential with the owner. */
const resumeAccount = Effect.fn('AdoptionProof.resumeAccount')(function* (
  actor: Actor,
  id: ConnectionId,
  receipts: Ref.Ref<ReadonlyArray<Receipt>>,
) {
  const database = yield* Database
  const previous = yield* row(id)
  yield* database.run(
    database
      .update(connections)
      .set({ status: 'needs-authorization', updatedAt: previous.updatedAt + 1 })
      .where(eq(connections.id, id)),
  )
  const offset = (yield* Ref.get(receipts)).length
  const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
  const store = yield* ConnectionStore.pipe(Effect.provide(context))
  expect(ConnectionStep.guards.Done(yield* store.resume(actor, id, 'Web'))).toBe(true)
  const probed = (yield* Ref.get(receipts))
    .slice(offset)
    .filter((receipt) => receipt.path.endsWith('/tools'))
  expect(probed.some((receipt) => receipt.principal === 'owner')).toBe(true)
  expect((yield* row(id)).status).toBe('ready')
})

/** Execution and retirement use the persisted principal, not a test-selected owner fallback. */
const prove = Effect.fn('AdoptionProof.prove')(function* (input: {
  actor: Actor
  other: ExecutorCaller
  request: typeof publicApp
  crash: Ref.Ref<Effect.Effect<void>>
  receipts: Ref.Ref<ReadonlyArray<Receipt>>
}) {
  const id = yield* legacy(input.actor, input.request, 'Complete')
  let before = Option.none<Effect.Success<ReturnType<typeof watchAt>>>()
  if (input.request === stored) {
    const current = yield* row(id)
    expect(
      yield* (yield* operationsOf(current)).call({
        references: current.references,
        tool: 'write',
        input: {},
      }),
    ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }))
    before = Option.some(yield* watchAt(id, Effect.void))
  }
  if (input.request === publicApp || input.request === stored)
    expect(yield* adoptConnections()).toBe(false)
  else before = Option.some(yield* crashAndResume(id, input.crash))
  const moved = yield* row(id)
  expect(moved.executorPrincipal).toBe(
    ExecutorReferences.guards.Authorized(moved.references) ? 'adopted-account' : 'adopted-public',
  )
  if (!ExecutorReferences.isAnyOf(['Public', 'Authorized'])(moved.references))
    return expect.fail('Expected adopted live reference')
  const ownership = moved.references.appOwnership
  if (!ExecutorAppOwnership.guards.Adopted(ownership))
    return expect.fail('Expected persisted group')
  const executor = yield* Executor
  const refused =
    moved.executorPrincipal === 'adopted-public' ? [input.other, installationCaller] : [input.other]
  for (const caller of refused) {
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
  if (Option.isSome(before)) yield* delivered(id, before.value)
  if (moved.executorPrincipal === 'adopted-account') {
    yield* resumeAccount(input.actor, id, input.receipts)
    const after = yield* watchAt(id, Effect.void)
    expect(ExecutorCaller.guards.Installation(after.caller)).toBe(true)
    yield* delivered(id, after)
  }
  expect(AdoptionFinalization.guards.Completed(ownership.finalization)).toBe(true)
  const requests = (yield* Ref.get(input.receipts)).length
  expect(yield* adoptConnections()).toBe(false)
  expect((yield* Ref.get(input.receipts)).length).toBe(requests)
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

/** Unconnected rows retire the old app before becoming Member; completed upstream grants defer. */
const unfinished = Effect.fn('AdoptionProof.unfinished')(function* (actor: Actor) {
  const database = yield* Database
  for (const kind of ['EnteringKey', 'ReconnectRequired', 'CompletedUpstream'] as const) {
    const id = yield* legacy(
      actor,
      kind === 'ReconnectRequired' ? publicApp : credential('Google'),
      'Pending',
    )
    const original = yield* row(id)
    if (ExecutorReferences.guards.ReconnectRequired(original.references))
      return expect.fail('Expected allocated app')
    const app = original.references.app
    if (kind === 'ReconnectRequired') {
      const references = ExecutorReferences.cases.ReconnectRequired.make({
        service: original.service,
        owner: original.references.owner,
        retired: retirementOf(original.references),
        reason: 'UnresolvedMigration',
      })
      yield* database.run(
        database
          .update(connections)
          .set({
            references: yield* encodeReferences(references),
            executorApp: null,
            status: 'failed',
            reason: 'Reconnect required',
          })
          .where(eq(connections.id, id)),
      )
    }
    if (kind === 'CompletedUpstream') {
      yield* (yield* Executor).as(installationCaller).complete({
        references: original.references,
        fields: { token: Redacted.make('finished-upstream') },
      })
    }
    expect(yield* adoptConnections()).toBe(false)
    const after = yield* row(id)
    if (kind === 'CompletedUpstream') {
      expect(after.executorPrincipal).toBe('installation')
      expect(yield* foreignStatus(`/apps/${app}`)).toBe(200)
    } else {
      expect(after.executorPrincipal).toBe('member')
      expect(after.executorApp).toBe(null)
      expect([403, 404]).toContain(yield* foreignStatus(`/apps/${app}`))
    }
    yield* removeConnection(after)
  }
})

/** A real unsupported factory is a permanent refusal, not a minute-by-minute retry. */
const unsupported = Effect.fn('AdoptionProof.unsupported')(function* (actor: Actor) {
  const request = credential('Google')
  const files = request.files.map((file) => ({
    path: file.path,
    content: file.content.replace(
      'async ({ user, signal, cache }) => {',
      'async (context) => { const { user, signal, cache } = context;',
    ),
  }))
  const id = yield* legacy(actor, { name: 'Unsupported factory', files }, 'Complete')
  expect(yield* adoptConnections()).toBe(false)
  const kept = yield* row(id)
  expect(kept.executorPrincipal).toBe('installation')
  expect(
    yield* (yield* operationsOf(kept)).call({
      references: kept.references,
      tool: 'read',
      input: {},
    }),
  ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: { marker: 'retained-marker' } }))
  yield* removeConnection(kept)
})

const decodeRpc = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
    method: Schema.String,
    params: Schema.optionalKey(Schema.Json),
  }),
)
const decodeInitialize = Schema.decodeUnknownEffect(
  Schema.Struct({ protocolVersion: Schema.String }),
)

/** Stand-ins replace only provider destinations and OAuth in the proof. The captured files,
 * old framework pins and router construction are the actual deployed workspaces. */
const capturedProvider = Effect.fn('AdoptionProof.capturedProvider')(function* () {
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  if (!NetAddress.isInetAddress(server.address)) return expect.fail('Expected provider listener')
  const origin = (yield* Effect.fromResult(NetAddress.toUrl(server.address))).origin
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.url.startsWith('/spec/')) {
        const mail = request.url.includes('gmail')
        const path = mail ? '/gmail/v1/users/me/profile' : '/calendar/v3/calendars/primary'
        return yield* HttpServerResponse.json({
          openapi: '3.0.3',
          info: { title: 'Captured Google proof', version: '1' },
          servers: [{ url: origin }],
          paths: {
            [path]: {
              get: {
                operationId: mail ? 'gmail.users.getProfile' : 'calendar.calendars.get',
                tags: [mail ? 'Gmail API' : 'Calendar API'],
                security: [{ googleOAuth2: [] }],
                responses: {
                  '200': {
                    description: 'Saved data',
                    content: { 'application/json': { schema: { type: 'object' } } },
                  },
                },
              },
            },
          },
        })
      }
      if (request.headers['authorization'] !== 'Bearer synthetic')
        return HttpServerResponse.empty({ status: 401 })
      if (request.url !== '/mcp')
        return yield* HttpServerResponse.json({ marker: 'saved-provider-data' })
      const rpc = yield* request.json.pipe(Effect.flatMap(decodeRpc))
      if (rpc.id === undefined) return HttpServerResponse.empty({ status: 202 })
      let result: Schema.Json
      switch (rpc.method) {
        case 'initialize': {
          const input = yield* decodeInitialize(rpc.params)
          result = {
            protocolVersion: input.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'Captured GitHub proof', version: '1' },
          }
          break
        }
        case 'tools/list':
          result = {
            tools: [
              {
                name: 'get_me',
                description: 'Read saved identity',
                inputSchema: { type: 'object', properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          }
          break
        case 'tools/call':
          result = {
            content: [{ type: 'text', text: '{"marker":"saved-provider-data"}' }],
            structuredContent: { marker: 'saved-provider-data' },
          }
          break
        default:
          return yield* HttpServerResponse.json({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32601, message: 'Method not found' },
          })
      }
      return yield* HttpServerResponse.json({ jsonrpc: '2.0', id: rpc.id, result })
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
  )
  return origin
})

/** Retain every captured router expression. Only the proof's OAuth and network destinations
 * are replaced; the production transformation never edits provider.ts or upstream addresses. */
function capturedFiles(workspace: typeof gmailWorkspace, name: string, origin: string) {
  return workspace.files.map((file) => {
    if (file.path === 'provider.ts')
      return {
        path: file.path,
        content: `import { defineProvider, secrets, object, string } from "apps";
export const provider = defineProvider({ name: ${JSON.stringify(name)}, hosts: [${JSON.stringify(new URL(origin).host)}], auth: { googleOAuth2: secrets({ label: "Key", fields: object({ access_token: string() }) }) } });`,
      }
    if (file.path !== 'index.ts') return file
    return {
      path: file.path,
      content: file.content
        .replace('https://integrations.sh/specs/google/google-gmail.json', origin + '/spec/gmail')
        .replace(
          'https://integrations.sh/specs/google/google-calendar.json',
          origin + '/spec/calendar',
        )
        .replace('https://gmail.googleapis.com', origin)
        .replace('https://www.googleapis.com', origin)
        .replace('https://api.githubcopilot.com/mcp/', origin + '/mcp')
        .replace('api.githubcopilot.com', new URL(origin).host),
    }
  })
}

/** Old single-account apps cannot use today's authored-app pre-auth schedule inspection.
 * Seed them with the public deploy/connect APIs used by their original installation path. */
const capturedCreate = Effect.fn('AdoptionProof.capturedCreate')(function* (
  actor: Actor,
  name: 'Gmail' | 'Google Calendar' | 'GitHub',
  files: typeof gmailWorkspace.files,
  key: string,
) {
  const database = yield* Database
  const owner = (yield* Executor).as(installationCaller)
  const id = ConnectionId.make(crypto.randomUUID())
  let inserted = false
  let held = Option.none<{
    app: typeof ExecutorAppId.Type
    account: Option.Option<typeof ExecutorAccountId.Type>
  }>()
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const [stored] = yield* database.run(
        database.select().from(connections).where(eq(connections.id, id)),
      )
      if (stored !== undefined) return yield* removeConnection(yield* decodeRow(stored))
      if (inserted) return
      if (Option.isSome(held))
        yield* owner.retire({
          resources: ExecutorRetired.make({
            original: held.value.app,
            ownership: 'Dedicated',
            account: held.value.account,
            copies: [],
            authorization: Option.none(),
          }),
          retainedApps: [],
          retainedAccounts: [],
        })
    }).pipe(
      Effect.result,
      Effect.map((result) => expect(Result.isSuccess(result)).toBe(true)),
    ),
  )
  const app = yield* capturedRequest(
    'POST',
    `/apps/deploy`,
    { name: `captured-${id}`, files },
    Schema.Struct({ id: ExecutorAppId }),
  )
  held = Option.some({ app: app.id, account: Option.none() })
  const requirement = key === 'token' ? 'service' : 'google'
  const method = key === 'token' ? 'pat' : 'googleOAuth2'
  const connection = yield* capturedRequest(
    'POST',
    `/apps/${app.id}/accounts/user/${requirement}/connections`,
    {},
    Schema.Struct({ id: ExecutorAuthorizationId }),
  )
  const account = yield* capturedRequest(
    'POST',
    `/connections/${connection.id}/submit`,
    { method, fields: { [key]: 'synthetic' } },
    Schema.Struct({ id: ExecutorAccountId }),
  )
  held = Option.some({ app: app.id, account: Option.some(account.id) })
  const references = ExecutorReferences.cases.Authorized.make({
    service: ServiceId.make(
      Match.value(name).pipe(
        Match.when('GitHub', () => 'curated/github-com-mcp'),
        Match.when('Gmail', () => 'google/gmail'),
        Match.when('Google Calendar', () => 'google/calendar'),
        Match.exhaustive,
      ),
    ),
    app: app.id,
    owner: ExecutorOwnerId.make(`p-${actor.person.id}`),
    binding: ExecutorBinding.cases.Account.make({ scope: 'user', requirement }),
    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
    account: account.id,
  })
  yield* database.run(
    database.insert(connections).values({
      id,
      personId: actor.person.id,
      companyId: null,
      service: references.service,
      serviceName: name,
      executorApp: app.id,
      references: yield* encodeReferences(references),
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
  inserted = true
  return { id, references }
})

/** Fixture setup calls only the disposable host's public API and validates every answer. */
const capturedRequest = <A, I>(
  method: 'POST' | 'DELETE',
  path: string,
  body: Schema.Json,
  schema: Schema.Codec<A, I>,
) =>
  Effect.gen(function* () {
    const url = yield* Config.String('VIVID_EXECUTOR_URL')
    const organization = yield* Config.String('VIVID_EXECUTOR_ORGANIZATION')
    const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.make(method)(`${url}/api/organizations/${organization}${path}`).pipe(
        HttpClientRequest.bearerToken(key),
      ),
      body,
    )
    const response = yield* client.execute(request)
    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
  }).pipe(Effect.scoped)

const CapturedApp = Schema.Struct({
  id: ExecutorAppId,
  requirements: Schema.Struct({
    accounts: Schema.Record(Schema.String, Schema.Struct({ provider: Schema.String })),
  }),
})

/** The original OAuth definitions are deployed byte-for-byte too. Their provider IDs must
 * survive the framework change, even though the account call proof uses synthetic credentials. */
const capturedIdentity = Effect.fn('AdoptionProof.capturedIdentity')(function* (
  workspace: typeof gmailWorkspace,
  requirement: string,
) {
  const app = yield* Effect.acquireRelease(
    capturedRequest(
      'POST',
      '/apps/deploy',
      { name: `identity-${crypto.randomUUID()}`, files: workspace.files },
      CapturedApp,
    ),
    (app) =>
      capturedRequest('DELETE', `/apps/${app.id}`, {}, Schema.Json).pipe(
        Effect.result,
        Effect.map((result) => expect(Result.isSuccess(result)).toBe(true)),
      ),
  )
  const before = app.requirements.accounts[requirement]
  if (before === undefined) return expect.fail('Expected original requirement')
  const files = yield* adoptionFiles(workspace.files, requirement, 'vividAdopted')
  const original = workspace.files.find((file) => file.path === 'index.ts')
  const changed = files.find((file) => file.path === 'index.ts')
  if (original === undefined || changed === undefined) return expect.fail('Expected captured index')
  expect(changed.content.match(/https?:\/\/[^"\s]+/gu)).toEqual(
    original.content.match(/https?:\/\/[^"\s]+/gu),
  )
  const revised = yield* capturedRequest(
    'POST',
    `/apps/${app.id}/deploy`,
    { files },
    Schema.Struct({ app: CapturedApp }),
  )
  expect(revised.app.requirements.accounts[requirement]).toEqual(before)
  expect(revised.app.requirements.accounts['vividAdopted']).toEqual(before)
})

/** Exercise the real pass from an old-version app/account. Neither adoption nor finalization
 * may change its tool names, schemas, returned data or provider declaration. */
const capturedSources = Effect.fn('AdoptionProof.capturedSources')(function* (actor: Actor) {
  const origin = yield* capturedProvider()
  const executor = yield* Executor
  const owner = executor.as(installationCaller)
  const members = yield* ExecutorMembers
  const caller = yield* members.caller({ principal: 'member', personId: actor.person.id })
  for (const entry of [
    { workspace: gmailWorkspace, name: 'Gmail', key: 'access_token' },
    { workspace: calendarWorkspace, name: 'Google Calendar', key: 'access_token' },
    { workspace: calendarWorkspace, name: 'Google Calendar', key: 'access_token' },
    { workspace: githubWorkspace, name: 'GitHub', key: 'token' },
  ] as const) {
    const files = capturedFiles(entry.workspace, entry.name, origin)
    const { id, references } = yield* capturedCreate(actor, entry.name, files, entry.key)
    const before = yield* owner.tools(references)
    expect(before.length).toBeGreaterThan(0)
    const [tool] = before
    if (tool === undefined) return expect.fail('Expected captured tool')
    const result = yield* owner.call({ references, tool: tool.name, input: {} })
    expect(ExecutorCallOutcome.guards.Completed(result)).toBe(true)
    const remaining = yield* adoptConnections()
    expect(remaining).toBe(false)
    const moved = yield* row(id)
    expect(moved.executorPrincipal, entry.name).toBe('adopted-account')
    if (!ExecutorReferences.guards.Authorized(moved.references))
      return expect.fail('Expected adopted account')
    expect(moved.references.app).toBe(references.app)
    expect(moved.references.account).toBe(references.account)
    const after = yield* executor.as(caller).tools(moved.references)
    expect(after.map((tool) => tool.name)).toEqual(before.map((tool) => tool.name))
    expect(after.map((tool) => tool.input)).toEqual(before.map((tool) => tool.input))
    expect(
      yield* executor.as(caller).call({ references: moved.references, tool: tool.name, input: {} }),
    ).toEqual(result)
    const deployed = yield* (yield* ExecutorAdoption).source(references.app)
    const originalProvider = files.find((file) => file.path === 'provider.ts')
    if (originalProvider !== undefined)
      expect(deployed.find((file) => file.path === 'provider.ts')).toEqual(originalProvider)
    yield* removeConnection(moved)
    yield* capturedIdentity(entry.workspace, entry.key === 'token' ? 'service' : 'google')
  }
})

/** Remove the real bridge link immediately before the member reads it. An ordinary link
 * mismatch must still defer adoption even when reconnect-required failures are accepted. */
const unavailableAdoption = Effect.fn('AdoptionProof.unavailableAdoption')(function* (
  actor: Actor,
  crash: Ref.Ref<Effect.Effect<void>>,
) {
  const id = yield* legacy(actor, credential('Google'), 'Complete')
  const original = yield* row(id)
  if (!ExecutorReferences.guards.Authorized(original.references))
    return expect.fail('Expected account')
  yield* Ref.set(
    crash,
    Ref.set(
      crash,
      capturedRequest(
        'DELETE',
        `/apps/${original.references.app}/accounts/app/vividAdopted/${original.references.account}`,
        {},
        Schema.Json,
      ).pipe(Effect.asVoid),
    ),
  )
  expect(yield* adoptConnections()).toBe(true)
  const deferred = yield* row(id)
  expect(deferred.executorPrincipal).toBe('installation')
  expect(ExecutorReferences.guards.Adopting(deferred.references)).toBe(true)
  yield* removeConnection(deferred)
})

/** A real token endpoint ends only the first grant. Executor must turn its invalid_grant
 * renewal response into OAuthReconnectRequired; no Executor responses are fabricated. */
const lapsedProvider = Effect.fn('AdoptionProof.lapsedProvider')(function* () {
  const exchanges = yield* Ref.make(0)
  const renewals = yield* Ref.make(0)
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.url === '/token') {
        const body = new URLSearchParams(yield* request.text)
        if (body.get('grant_type') === 'refresh_token') {
          yield* Ref.update(renewals, (count) => count + 1)
          return yield* HttpServerResponse.json({ error: 'invalid_grant' }, { status: 400 })
        }
        const count = yield* Ref.updateAndGet(exchanges, (count) => count + 1)
        return yield* HttpServerResponse.json({
          access_token: count === 1 ? 'expired-proof' : 'renewed-proof',
          refresh_token: 'proof-refresh',
          token_type: 'Bearer',
          expires_in: count === 1 ? 1 : 3600,
          scope: 'read',
        })
      }
      if (request.headers['authorization'] !== 'Bearer renewed-proof')
        return HttpServerResponse.empty({ status: 401 })
      return yield* HttpServerResponse.json({ marker: 'renewed-account' })
    }),
  )
  if (!NetAddress.isInetAddress(server.address)) return expect.fail('Expected OAuth listener')
  return {
    origin: (yield* Effect.fromResult(NetAddress.toUrl(server.address))).origin,
    exchanges,
    renewals,
  }
})

/** The provider's sign-in return preserves Executor's real state and redirect URI. */
function lapsedCallback(address: string) {
  const authorization = new URL(address)
  const redirect = authorization.searchParams.get('redirect_uri')
  const state = authorization.searchParams.get('state')
  if (redirect === null || state === null) return expect.fail('Expected OAuth redirect and state')
  const callback = new URL(redirect)
  callback.searchParams.set('state', state)
  callback.searchParams.set('code', 'disposable-code')
  return callback.href
}

/** Public deploy/connect APIs seed the installation-era account, including its actual expired grant.
 * Cleanup is registered before deployment and uses only this fixture's captured resources. */
const lapsedLegacy = Effect.fn('AdoptionProof.lapsedLegacy')(function* (
  actor: Actor,
  origin: string,
) {
  const database = yield* Database
  const id = ConnectionId.make(crypto.randomUUID())
  let held = Option.none<typeof ExecutorAppId.Type>()
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const [stored] = yield* database.run(
        database.select().from(connections).where(eq(connections.id, id)),
      )
      if (stored !== undefined) return yield* removeConnection(yield* decodeRow(stored))
      if (Option.isSome(held))
        yield* capturedRequest('DELETE', `/apps/${held.value}`, {}, Schema.Json)
    }),
  )
  const request = credential('Google')
  const files = madeFiles({
    name: 'Lapsed OAuth proof',
    files: request.files.map((file) => ({
      ...file,
      content: file.content
        .replace('secrets,', 'oauth2,')
        .replace('async ({ user, signal, cache })', 'async ({ user, signal, cache, fetch })')
        .replace(
          'secrets({ label: "Key", fields: object({ token: string() }) })',
          `oauth2({ authorizationUrl: ${JSON.stringify(origin + '/authorize')}, tokenUrl: ${JSON.stringify(origin + '/token')}, scopes: ["read"] })`,
        )
        .replace(
          '({ marker: account.fields.token })',
          `await (await fetch(${JSON.stringify(origin + '/data')}, { headers: { Authorization: "Bearer " + account.fields.access_token } })).json()`,
        )
        .replace(
          'name: "Adopt proof",',
          `name: "Adopt proof", hosts: [${JSON.stringify(new URL(origin).host)}],`,
        ),
    })),
  })
  const app = yield* capturedRequest(
    'POST',
    '/apps/deploy',
    { name: `lapsed-${id}`, files },
    Schema.Struct({ id: ExecutorAppId }),
  )
  held = Option.some(app.id)
  const connection = yield* capturedRequest(
    'POST',
    `/apps/${app.id}/accounts/user/google/connections`,
    {},
    Schema.Struct({ id: ExecutorAuthorizationId }),
  )
  const client = yield* Effect.acquireRelease(
    capturedRequest(
      'POST',
      '/oauth-clients',
      {
        issuer: origin + '/token',
        clientId: 'proof-client',
        clientSecret: 'proof-secret',
      },
      Schema.Struct({ client: Schema.Struct({ id: Schema.String }) }),
    ),
    (saved) => capturedRequest('DELETE', `/oauth-clients/${saved.client.id}`, {}, Schema.Json),
  )
  const signIn = yield* capturedRequest(
    'POST',
    `/connections/${connection.id}/oauth/start`,
    { method: 'key', client: { id: client.client.id } },
    Schema.Struct({ authorizationUrl: Schema.String }),
  )
  const account = yield* capturedRequest(
    'POST',
    `/connections/${connection.id}/oauth/complete`,
    { callbackUrl: lapsedCallback(signIn.authorizationUrl) },
    Schema.Struct({ id: ExecutorAccountId }),
  )
  const references = ExecutorReferences.cases.Authorized.make({
    service: ServiceId.make('made:lapsed-oauth-proof'),
    app: app.id,
    owner: ExecutorOwnerId.make(`p-${actor.person.id}`),
    binding: ExecutorBinding.cases.Account.make({ scope: 'user', requirement: 'google' }),
    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
    account: account.id,
  })
  yield* database.run(
    database.insert(connections).values({
      id,
      personId: actor.person.id,
      companyId: null,
      service: references.service,
      serviceName: 'Lapsed OAuth proof',
      executorApp: app.id,
      references: yield* encodeReferences(references),
      status: 'needs-authorization',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
  return { id, references }
})

/** Resume is exercised only after finalization removes the old user requirement. It must
 * reconnect the owner-created account in place, then dispatch tools with the member key. */
const lapsed = Effect.fn('AdoptionProof.lapsed')(function* (
  actor: Actor,
  receipts: Ref.Ref<ReadonlyArray<Receipt>>,
) {
  const remote = yield* lapsedProvider()
  const legacy = yield* lapsedLegacy(actor, remote.origin)
  expect(yield* adoptConnections()).toBe(false)
  const moved = yield* row(legacy.id)
  expect(moved.executorPrincipal).toBe('adopted-account')
  expect(moved.status).toBe('needs-authorization')
  if (!ExecutorReferences.guards.Authorized(moved.references))
    return expect.fail('Expected account')
  expect(moved.references.account).toBe(legacy.references.account)
  const ownership = moved.references.appOwnership
  if (!ExecutorAppOwnership.guards.Adopted(ownership)) return expect.fail('Expected adoption')
  expect(AdoptionFinalization.guards.Completed(ownership.finalization)).toBe(true)
  expect(yield* Ref.get(remote.renewals)).toBeGreaterThan(0)
  const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
  const store = yield* ConnectionStore.pipe(Effect.provide(context))
  const step = yield* store.resume(actor, legacy.id, 'Web')
  if (!ConnectionStep.guards.OpenSignIn(step)) return expect.fail('Expected reconnect sign-in')
  yield* store.callback(actor, legacy.id, Redacted.make(lapsedCallback(step.address)))
  const ready = yield* row(legacy.id)
  expect(ready.status).toBe('ready')
  if (!ExecutorReferences.guards.Authorized(ready.references))
    return expect.fail('Expected account')
  expect(ready.references.account).toBe(legacy.references.account)
  expect(ready.references.binding).toEqual({
    _tag: 'Account',
    scope: 'app',
    requirement: 'vividAdopted',
  })
  const offset = (yield* Ref.get(receipts)).length
  expect(
    yield* (yield* operationsOf(ready)).call({
      references: ready.references,
      tool: 'read',
      input: {},
    }),
  ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: { marker: 'renewed-account' } }))
  const called = (yield* Ref.get(receipts))
    .slice(offset)
    .filter((receipt) => receipt.method === 'POST')
  expect(called.length).toBeGreaterThan(0)
  expect(called.every((receipt) => receipt.principal === 'member')).toBe(true)
  expect(yield* Ref.get(remote.exchanges)).toBe(2)
  expect(yield* adoptConnections()).toBe(false)
})

describe.skipIf(!enabled || !testDatabaseConfigured)('Executor adoption', () => {
  layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
    it.effect(
      'adopts a lapsed OAuth grant and reconnects its finalized account in place',
      () =>
        Effect.gen(function* () {
          const actors = yield* fixture()
          const receipts = yield* Ref.make<ReadonlyArray<Receipt>>([])
          const crash = yield* Ref.make<Effect.Effect<void>>(Effect.void)
          const context = yield* Layer.build(liveLayers(crash, receipts))
          yield* lapsed(actors.personalActor, receipts).pipe(Effect.provide(context))
          yield* unavailableAdoption(actors.personalActor, crash).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      { timeout: 240_000 },
    )

    it.effect(
      'adopts the captured beta.19 GitHub and beta.22 Google workspaces without changing tools or data',
      () =>
        Effect.gen(function* () {
          const actors = yield* fixture()
          const context = yield* Layer.build(
            liveLayers(
              yield* Ref.make<Effect.Effect<void>>(Effect.void),
              yield* Ref.make<ReadonlyArray<Receipt>>([]),
            ),
          )
          yield* capturedSources(actors.personalActor).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      { timeout: 240_000 },
    )

    it.effect(
      'recovers adoption, keeps Account Watch/status authority, retires unfinished apps and terminates',
      () =>
        Effect.gen(function* () {
          const actors = yield* fixture()
          const crash = yield* Ref.make<Effect.Effect<void>>(Effect.void)
          const receipts = yield* Ref.make<ReadonlyArray<Receipt>>([])
          const context = yield* Layer.build(liveLayers(crash, receipts))
          yield* Effect.gen(function* () {
            const members = yield* ExecutorMembers
            yield* members.caller({
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
              yield* prove({ actor: actors.personalActor, other, request, crash, receipts })
            yield* unfinished(actors.personalActor)
            yield* unsupported(actors.personalActor)
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      { timeout: 240_000 },
    )
  })
})
