import { describe, expect, it, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import {
  Forbidden,
  MakeIntegrationOutcome,
  MakeIntegrationRequest,
  CompleteConnectionRequest,
  SessionId,
} from '@vivid/contracts'
import { Context, Effect, Layer, Ref, Result, Schema, Redacted } from 'effect'
import { eq } from 'drizzle-orm'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { connectionHandlers } from './handlers.ts'
import { ExecutorAppOwnership, ExecutorReferences } from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connections } from './tables.ts'
import { connectionTestLayer, fixture, hostedExecutorFixture, hostedPrefix } from './testing.ts'

const request = MakeIntegrationRequest.make({
  name: 'Morning check',
  files: [{ path: 'index.ts', content: 'export default {}' }],
})

const decodeRequest = Schema.decodeEffect(MakeIntegrationRequest)
const decodeDeploy = Schema.decodeUnknownEffect(
  Schema.Struct({
    name: Schema.String,
    files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  }),
)
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      dependencies: Schema.Struct({ apps: Schema.String }),
    }),
  ),
)
const BuildFailure = Schema.TaggedStruct('VersionBuildFailed', {
  owner: Schema.String,
  name: Schema.String,
  reason: Schema.String,
  message: Schema.String,
})

/** Exercise handlers and real persistence over the production HTTP adapter, with a local host. */
const madeFixture = Effect.fn('MadeTest.fixture')(function* () {
  const actors = yield* fixture()
  const hosted = yield* hostedExecutorFixture()
  yield* Ref.update(hosted.replies, (replies) =>
    new Map(replies).set(`GET ${hostedPrefix}/apps/app/schedules/definitions`, {
      status: 200,
      body: [],
    }),
  )
  const executor = yield* Layer.build(hosted.configured)
  const context = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
    Effect.provide(executor),
  )
  const auth = AuthState.Vivid({
    person: actors.ownerActor.person,
    workspace: actors.ownerActor.workspace,
    threadId: actors.threadId,
  })
  return {
    ...actors,
    hosted,
    store: Context.get(context, ConnectionStore),
    complete: (input: CompleteConnectionRequest) =>
      connectionHandlers.CompleteConnection(input).pipe(
        Effect.provide(context),
        Effect.provideService(
          AuthContext,
          AuthState.Person({
            person: actors.ownerActor.person,
            workspace: actors.ownerActor.workspace,
            sessionId: SessionId.make('made-test'),
          }),
        ),
      ),
    make: (input: MakeIntegrationRequest) =>
      connectionHandlers
        .MakeIntegration(input)
        .pipe(Effect.provide(context), Effect.provideService(AuthContext, auth)),
    remove: (id: Parameters<typeof connectionHandlers.RemoveConnection>[0]['id']) =>
      connectionHandlers.RemoveConnection({ id }).pipe(
        Effect.provide(context),
        Effect.provideService(
          AuthContext,
          AuthState.Person({
            person: actors.ownerActor.person,
            workspace: actors.ownerActor.workspace,
            sessionId: SessionId.make('made-test'),
          }),
        ),
      ),
  }
})

describe('authored source contract', () => {
  for (const path of [
    'package.json',
    '../x',
    '/index.ts',
    'src/../x',
    'src\\x',
    './package.json',
  ]) {
    it.effect(`refuses ${path}`, () =>
      Effect.gen(function* () {
        const result = yield* decodeRequest({
          ...request,
          files: [{ path, content: '' }],
        }).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }),
    )
  }
  it.effect('refuses duplicate paths and excess source', () =>
    Effect.gen(function* () {
      for (const files of [
        [],
        [...request.files, ...request.files],
        Array.from({ length: 31 }, (_, index) => ({ path: `${index}.ts`, content: '' })),
        [{ path: 'index.ts', content: 'x'.repeat(200_001) }],
      ]) {
        expect(
          Result.isFailure(yield* decodeRequest({ ...request, files }).pipe(Effect.result)),
        ).toBe(true)
      }
    }),
  )
})

describe.skipIf(!testDatabaseConfigured)('made Integrations through real adapters', () => {
  layer(connectionTestLayer)((test) => {
    test.effect(
      'deploys a dedicated ready account, pins apps, enables only app schedules and removes it',
      () =>
        Effect.gen(function* () {
          const made = yield* madeFixture()
          yield* Ref.update(made.hosted.replies, (replies) =>
            new Map(replies)
              .set(`GET ${hostedPrefix}/apps/app/schedules/definitions`, {
                status: 200,
                body: [{ name: 'morning', scope: 'app' }, { name: 'personal' }],
              })
              .set(`PATCH ${hostedPrefix}/apps/app/schedules/morning`, {
                status: 200,
                body: { enabled: true },
              }),
          )
          expect(yield* made.make(request)).toEqual(
            MakeIntegrationOutcome.cases.Made.make({ account: request.name }),
          )
          const rows = yield* made.store.records(made.ownerActor)
          expect(rows).toHaveLength(1)
          const row = rows[0]
          if (row === undefined) return expect.fail('Expected made Connection')
          expect(row.status).toBe('ready')
          expect(ExecutorReferences.guards.Public(row.references)).toBe(true)
          if (!ExecutorReferences.guards.Public(row.references))
            return expect.fail('Expected public references')
          expect(ExecutorAppOwnership.guards.Dedicated(row.references.appOwnership)).toBe(true)
          const database = yield* Database
          const persisted = yield* database.run(
            database
              .select({ app: connections.executorApp })
              .from(connections)
              .where(eq(connections.id, row.id)),
          )
          expect(persisted).toEqual([{ app: row.references.app }])
          const requests = yield* Ref.get(made.hosted.requests)
          const deployed = requests.find((sent) => sent.path === `POST ${hostedPrefix}/apps/deploy`)
          if (deployed === undefined) return expect.fail('Expected deploy request')
          const body = yield* decodeDeploy(deployed.body)
          expect(body.name).toMatch(/^Vivid Integration [a-f0-9]{64}$/u)
          expect(body.files.find((file) => file.path === 'index.ts')).toEqual(request.files[0])
          const manifest = body.files.find((file) => file.path === 'package.json')
          if (manifest === undefined) return expect.fail('Expected pinned manifest')
          expect(yield* decodeManifest(manifest.content)).toEqual({
            dependencies: { apps: '0.0.1-beta.92' },
          })
          expect(
            requests
              .filter((sent) => sent.path.startsWith(`PATCH ${hostedPrefix}/apps/app/schedules/`))
              .map((sent) => ({ path: sent.path, body: sent.body })),
          ).toEqual([
            {
              path: `PATCH ${hostedPrefix}/apps/app/schedules/morning`,
              body: { enabled: true, scope: 'app' },
            },
          ])
          expect(yield* made.make(request)).toEqual(
            MakeIntegrationOutcome.cases.AlreadyConnected.make({
              account: request.name,
              name: request.name,
            }),
          )
          expect(yield* Ref.get(made.hosted.apps)).toHaveLength(1)
          yield* made.remove(row.id)
          expect(yield* made.store.records(made.ownerActor)).toEqual([])
          expect(yield* Ref.get(made.hosted.apps)).toEqual([])
        }),
    )

    test.effect(
      'returns compiler diagnostics without a Connection or app, then allows a retry',
      () =>
        Effect.gen(function* () {
          const made = yield* madeFixture()
          yield* Ref.update(made.hosted.replies, (replies) =>
            new Map(replies).set(`POST ${hostedPrefix}/apps/deploy`, {
              status: 422,
              body: BuildFailure.make({
                owner: 'host-owner',
                name: 'host-app',
                reason: 'compile',
                message: ' index.ts: invalid source ',
              }),
            }),
          )
          expect(yield* made.make(request)).toEqual(
            MakeIntegrationOutcome.cases.BuildFailed.make({ message: 'index.ts: invalid source' }),
          )
          expect(yield* made.store.records(made.ownerActor)).toEqual([])
          expect(yield* Ref.get(made.hosted.apps)).toEqual([])
          yield* Ref.update(made.hosted.replies, (replies) => {
            const next = new Map(replies)
            next.delete(`POST ${hostedPrefix}/apps/deploy`)
            return next
          })
          expect(MakeIntegrationOutcome.guards.Made(yield* made.make(request))).toBe(true)
        }),
    )

    test.effect('compensates an app when schedule configuration fails', () =>
      Effect.gen(function* () {
        const made = yield* madeFixture()
        yield* Ref.update(made.hosted.replies, (replies) =>
          new Map(replies).set(`GET ${hostedPrefix}/apps/app/schedules/definitions`, {
            status: 503,
            body: {},
          }),
        )
        expect(Result.isFailure(yield* made.make(request).pipe(Effect.result))).toBe(true)
        expect(yield* made.store.records(made.ownerActor)).toEqual([])
        expect(yield* Ref.get(made.hosted.apps)).toEqual([])
      }),
    )

    test.effect('retains and resumes secure key authorization without deploying again', () =>
      Effect.gen(function* () {
        const made = yield* madeFixture()
        yield* Ref.set(made.hosted.accounts, {
          slot: {
            provider: 'provider',
            definition: {
              auth: {
                key: { type: 'secrets', fields: { properties: { token: { title: 'Token' } } } },
              },
            },
          },
        })
        const pending = yield* made.make(request)
        expect(MakeIntegrationOutcome.guards.PendingAuthorization(pending)).toBe(true)
        if (!MakeIntegrationOutcome.guards.PendingAuthorization(pending))
          return expect.fail('Expected authorization')
        expect(pending.step._tag).toBe('EnterKey')
        const id = pending.step.connection.id
        const resumed = yield* made.make(request)
        expect(MakeIntegrationOutcome.guards.PendingAuthorization(resumed)).toBe(true)
        if (!MakeIntegrationOutcome.guards.PendingAuthorization(resumed))
          return expect.fail('Expected resumed authorization')
        expect(resumed.step.connection.id).toBe(id)
        expect(
          (yield* Ref.get(made.hosted.requests)).filter(
            (sent) => sent.path === `POST ${hostedPrefix}/apps/deploy`,
          ),
        ).toHaveLength(1)
        yield* made.complete({ id, fields: { token: Redacted.make('isolated-test-token') } })
        expect((yield* made.store.get(made.ownerActor, id)).status).toBe('ready')
        expect(MakeIntegrationOutcome.guards.AlreadyConnected(yield* made.make(request))).toBe(true)
        yield* made.remove(id)
        expect(yield* Ref.get(made.hosted.apps)).toEqual([])
      }),
    )

    test.effect('refuses a signed-in Person before deployment', () =>
      Effect.gen(function* () {
        const made = yield* madeFixture()
        const outcome = yield* connectionHandlers.MakeIntegration(request).pipe(
          Effect.provideService(
            AuthContext,
            AuthState.Person({
              person: made.ownerActor.person,
              workspace: made.ownerActor.workspace,
              sessionId: SessionId.make('person'),
            }),
          ),
          Effect.result,
        )
        expect(Result.isFailure(outcome) && outcome.failure instanceof Forbidden).toBe(true)
        expect(yield* Ref.get(made.hosted.apps)).toEqual([])
      }),
    )
  })
})
