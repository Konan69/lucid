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
import { madeFiles } from './made.ts'
import { decodeRow, encodeReferences } from './records.ts'
import { removeConnection } from './removal.ts'
import { connections } from './tables.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { makeWatchedApps } from '../watches/apps.ts'
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
          if (request.method === 'PUT' && request.url.includes('/accounts/app/'))
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

describe.skipIf(!enabled || !testDatabaseConfigured)('Executor adoption', () => {
  layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
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
