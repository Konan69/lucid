import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, PersonId, ServiceId } from '@vivid/contracts'
import { eq, sql } from 'drizzle-orm'
import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Result, Schema } from 'effect'
import { Cookies, HttpClient, HttpClientRequest } from 'effect/http'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  Executor,
  ExecutorCaller,
  ExecutorCallOutcome,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorStep,
  executorLayer,
  installationCaller,
} from './executor.ts'
import { madeFiles } from './made.ts'
import { ExecutorMembers, MemberState, executorMembersLayer, operationsOf } from './members.ts'
import { encodeReferences } from './records.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connections, executorMembers } from './tables.ts'
import { connectionTestLayer, fixture } from './testing.ts'

const decodeState = Schema.decodeUnknownEffect(MemberState)
const decodeMembers = Schema.decodeUnknownEffect(
  Schema.Struct({
    members: Schema.Array(Schema.Struct({ userId: Schema.String })),
    total: Schema.Int,
  }),
)

/** Cleanup failures fail the proof, while every remaining scoped cleanup still runs. */
const cleanup = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.result,
    Effect.map((result) => {
      expect(Result.isSuccess(result)).toBe(true)
    }),
  )

const enabled = NodeProcess.env['VIVID_LIVE_EXECUTOR_MEMBERS'] === '1'
const settings = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    GOOGLE_CLIENT_ID: 'isolated-test-client',
    GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
    VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_PUBLIC_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
    VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
    VIVID_EXECUTOR_OWNER_EMAIL: NodeProcess.env['VIVID_TEST_EXECUTOR_OWNER_EMAIL'],
    VIVID_EXECUTOR_OWNER_PASSWORD: NodeProcess.env['VIVID_TEST_EXECUTOR_OWNER_PASSWORD'],
    VIVID_EXECUTOR_SEAL_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_SEAL_KEY'],
  }),
)
const realExecutor = Layer.mergeAll(executorLayer, executorMembersLayer).pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(settings),
)

/** A real beta.23 app reads a synthetic personal credential without a third-party dependency. */
const request = {
  name: 'Member proof',
  files: [
    {
      path: 'index.ts',
      content: `import { query, defineApp, defineProvider, secrets, object, string, json, router, accountRouter } from "apps";
const service = defineProvider({ name: "Member proof", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ({ user, signal }) => ({ tools: await accountRouter(user?.accounts.service ?? [], (account) => router({ read: query({ description: "Read this member's proof credential", input: object({}), output: json() }, async () => ({ marker: account.fields.token })) }), { signal }) }));`,
    },
  ],
}

/** Owner session reads Executor's member count independently of Vivid's member rows. */
const memberInventory = Effect.fn('MembersProof.inventory')(function* () {
  const url = yield* Config.String('VIVID_EXECUTOR_URL')
  const email = yield* Config.String('VIVID_EXECUTOR_OWNER_EMAIL')
  const password = yield* Config.Redacted('VIVID_EXECUTOR_OWNER_PASSWORD')
  const organization = yield* Config.String('VIVID_EXECUTOR_ORGANIZATION')
  const http = HttpClient.withScope(yield* HttpClient.HttpClient)
  const signIn = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(`${url}/api/auth/sign-in/email`).pipe(
      HttpClientRequest.setHeader('origin', url),
    ),
    { email, password: Redacted.value(password) },
  )
  const signedIn = yield* http.execute(signIn)
  expect(signedIn.status).toBe(200)
  const cookie = Cookies.toCookieHeader(signedIn.cookies)
  return Effect.fn('MembersProof.listMembers')(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(`${url}/api/auth/organization/list-members`).pipe(
        HttpClientRequest.setUrlParam('organizationId', organization),
        HttpClientRequest.setHeader('cookie', cookie),
      ),
    )
    expect(response.status).toBe(200)
    const body = yield* response.json
    return yield* decodeMembers(body)
  })
})

/** Start through the production store so the principal and first-use provisioning are exercised. */
const connect = Effect.fn('MembersProof.connect')(function* (actor: Actor) {
  const store = yield* ConnectionStore
  const begun = yield* store.make(actor, request)
  expect(begun.connection.state._tag).toBe('NeedsAuthorization')
  yield* store.complete(actor, {
    id: begun.connection.id,
    fields: { token: Redacted.make(`marker-${actor.person.id}`) },
  })
  const row = (yield* store.records(actor)).find((entry) => entry.id === begun.connection.id)
  if (row === undefined) return expect.fail('Expected persisted personal Connection')
  expect(row.executorPrincipal).toBe('member')
  expect(ExecutorReferences.guards.Authorized(row.references)).toBe(true)
  return row
})

/** Discovery and execution both cross Vivid's real HTTP adapter with the selected principal. */
const read = Effect.fn('MembersProof.read')(function* (
  row: Parameters<typeof operationsOf>[0] & { readonly references: ExecutorReferences },
  marker: string,
) {
  const operations = yield* operationsOf(row)
  const tools = yield* operations.tools(row.references)
  expect(tools.map((tool) => tool.name)).toContain('read')
  const outcome = yield* operations.call({ references: row.references, tool: 'read', input: {} })
  expect(outcome).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: { marker } }))
})

/** One pre-members Connection keeps the column default and installation-owned app/account. */
const legacy = Effect.fn('MembersProof.legacy')(function* (actor: Actor) {
  const database = yield* Database
  const executor = (yield* Executor).as(installationCaller)
  const store = yield* ConnectionStore
  const id = ConnectionId.make(crypto.randomUUID())
  const begun = yield* executor.make({
    connectionId: id,
    service: ServiceId.make('made:installation-proof'),
    owner: ExecutorOwnerId.make(`p-${actor.person.id}`),
    subject: actor.person.id,
    label: 'Installation proof',
    returnAddress: 'https://vivid.example.test/api/connections/return',
    files: madeFiles(request),
  })
  let retained = false
  let current = begun.references
  yield* Effect.addFinalizer(() =>
    retained ? cleanup(store.remove(actor, id)) : cleanup(executor.remove(current)),
  )
  if (!ExecutorStep.guards.EnterKey(begun)) return expect.fail('Expected personal key entry')
  const references = yield* executor.complete({
    references: begun.references,
    fields: { token: Redacted.make('installation-marker') },
  })
  current = references
  yield* database.run(
    database.insert(connections).values({
      id,
      personId: actor.person.id,
      companyId: null,
      service: references.service,
      serviceName: 'Installation proof',
      name: null,
      identity: null,
      executorApp: references.app,
      references: yield* encodeReferences(references),
      status: 'ready',
      reason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
  retained = true
  const row = (yield* store.records(actor)).find((entry) => entry.id === id)
  if (row === undefined) return expect.fail('Expected existing Installation Connection')
  expect(row.executorPrincipal).toBe('installation')
  yield* read(row, 'installation-marker')
})

/** A real SQL failure after register leaves Provisioning committed. A sequence survives rollback. */
const interrupted = Effect.fn('MembersProof.interrupted')(function* (
  person: PersonId,
  inventory: Effect.Success<ReturnType<typeof memberInventory>>,
) {
  const database = yield* Database
  const members = yield* ExecutorMembers
  yield* Effect.addFinalizer(() =>
    cleanup(
      Effect.forEach(
        [
          sql`DROP TRIGGER IF EXISTS member_proof_failure ON vivid_executor_members`,
          sql`DROP FUNCTION IF EXISTS member_proof_failure()`,
          sql`DROP SEQUENCE IF EXISTS member_proof_attempt`,
        ],
        (statement) => database.run(database.execute(statement)),
      ),
    ),
  )
  yield* database.run(database.execute(sql`CREATE SEQUENCE member_proof_attempt`))
  yield* database.run(
    database.execute(sql`
    CREATE FUNCTION member_proof_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state->>'_tag' = 'Ready' AND nextval('member_proof_attempt') = 1 THEN
        RAISE EXCEPTION 'proof rejects first sealed key write';
      END IF;
      RETURN NEW;
    END $$
  `),
  )
  yield* database.run(
    database.execute(sql`
    CREATE TRIGGER member_proof_failure BEFORE UPDATE ON vivid_executor_members
      FOR EACH ROW EXECUTE FUNCTION member_proof_failure()
  `),
  )
  const before = yield* inventory()
  const failed = yield* members
    .caller({ principal: 'member', personId: person })
    .pipe(Effect.result)
  expect(failed._tag).toBe('Failure')
  const [pending] = yield* database.run(
    database.select().from(executorMembers).where(eq(executorMembers.personId, person)),
  )
  if (pending === undefined) return expect.fail('Expected durable Provisioning row')
  expect((yield* decodeState(pending.state))._tag).toBe('Provisioning')
  const registered = yield* inventory()
  expect(registered.total).toBe(before.total + 1)
  yield* members.caller({ principal: 'member', personId: person })
  expect(yield* inventory()).toEqual(registered)
  const [ready] = yield* database.run(
    database.select().from(executorMembers).where(eq(executorMembers.personId, person)),
  )
  if (ready === undefined) return expect.fail('Expected recovered member')
  expect((yield* decodeState(ready.state))._tag).toBe('Ready')
})

/** Opt-in acceptance uses only the caller-supplied disposable beta.23 and PostgreSQL instances. */
describe.skipIf(!enabled || !testDatabaseConfigured)('Executor per-Person members', () => {
  layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
    it.effect(
      'isolates members, preserves installation calls, removes accounts and resumes provisioning',
      () =>
        Effect.gen(function* () {
          const actors = yield* fixture()
          const real = yield* Layer.build(realExecutor)
          const built = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
            Effect.provide(real),
          )
          const context = Context.merge(real, built)
          const a = actors.personalActor
          const b = { ...actors.memberActor, workspace: a.workspace }
          const store = Context.get(context, ConnectionStore)
          yield* Effect.addFinalizer(() =>
            cleanup(
              Effect.forEach([a, b], (actor) =>
                store
                  .records(actor)
                  .pipe(
                    Effect.flatMap((rows) =>
                      Effect.forEach(rows, (row) => store.remove(actor, row.id)),
                    ),
                  ),
              ).pipe(Effect.asVoid),
            ),
          )
          yield* Effect.gen(function* () {
            const members = yield* ExecutorMembers
            const executor = yield* Executor
            const database = yield* Database
            const inventory = yield* memberInventory()
            const before = yield* inventory()
            const rowA = yield* connect(a)
            const rowB = yield* connect(b)
            const callerA = yield* members.caller({ principal: 'member', personId: a.person.id })
            const callerB = yield* members.caller({ principal: 'member', personId: b.person.id })
            if (!ExecutorCaller.guards.Member(callerA) || !ExecutorCaller.guards.Member(callerB))
              return expect.fail('Expected two member callers')
            expect(Redacted.value(callerA.key) === Redacted.value(callerB.key)).toBe(false)
            const after = yield* inventory()
            expect(after.total).toBe(before.total + 2)
            const saved = yield* database.run(database.select().from(executorMembers))
            for (const person of [a.person.id, b.person.id]) {
              const held = saved.find((entry) => entry.personId === person)
              if (held === undefined) return expect.fail('Expected one member per Person')
              const state = yield* decodeState(held.state)
              if (!MemberState.guards.Ready(state)) return expect.fail('Expected Ready member')
              expect(after.members.filter((entry) => entry.userId === state.user)).toHaveLength(1)
              expect(held.email).toMatch(/^m-[a-f0-9]+@members\.vivid\.invalid$/u)
              expect(held.email).not.toContain(person)
              if (ExecutorCaller.guards.Member(callerA))
                expect(state.sealedKey).not.toContain(Redacted.value(callerA.key))
            }
            yield* read(rowA, `marker-${a.person.id}`)
            yield* read(rowA, `marker-${a.person.id}`)
            yield* read(rowB, `marker-${b.person.id}`)
            expect(yield* inventory()).toEqual(after)
            for (const caller of [callerB, installationCaller]) {
              const refusedList = yield* executor
                .as(caller)
                .tools(rowA.references)
                .pipe(Effect.result)
              const refusedCall = yield* executor
                .as(caller)
                .call({ references: rowA.references, tool: 'read', input: {} })
                .pipe(Effect.result)
              if (Result.isSuccess(refusedList) || Result.isSuccess(refusedCall))
                return expect.fail('Executor accepted another member or owner')
              expect(refusedList.failure._tag).toBe('ExecutorAccessDenied')
              expect(refusedCall.failure._tag).toBe('ExecutorAccessDenied')
            }
            yield* legacy(a)
            yield* store.remove(a, rowA.id)
            const url = yield* Config.String('VIVID_EXECUTOR_URL')
            const organization = yield* Config.String('VIVID_EXECUTOR_ORGANIZATION')
            if (
              !ExecutorCaller.guards.Member(callerA) ||
              !ExecutorReferences.guards.Authorized(rowA.references)
            )
              return expect.fail('Expected member account')
            const http = HttpClient.withScope(yield* HttpClient.HttpClient)
            for (const path of [
              `apps/${rowA.references.app}`,
              `accounts/${rowA.references.account}`,
            ]) {
              const response = yield* http.execute(
                HttpClientRequest.get(`${url}/api/organizations/${organization}/${path}`).pipe(
                  HttpClientRequest.bearerToken(callerA.key),
                ),
              )
              expect([403, 404]).toContain(response.status)
            }
            const recovery = yield* fixture()
            yield* interrupted(recovery.personalActor.person.id, inventory)
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
      { timeout: 240_000 },
    )
  })
})
