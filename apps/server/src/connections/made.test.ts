import { NodeHttpServerRequest } from '@effect/platform-node'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import {
  Forbidden,
  InvalidRequest,
  ConnectionId,
  ServiceId,
  MakeIntegrationOutcome,
  MakeIntegrationRequest,
  CompleteConnectionRequest,
  SessionId,
} from '@vivid/contracts'
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
  Redacted,
} from 'effect'
import { eq } from 'drizzle-orm'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { connectionHandlers } from './handlers.ts'
import {
  Executor,
  ExecutorAppOwnership,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorSetupRequired,
  connectionSetupMessage,
} from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connections } from './tables.ts'
import {
  connectionTestLayer,
  fixture,
  hostedExecutorFixture,
  hostedPrefix,
  hostedService,
} from './testing.ts'

const request = MakeIntegrationRequest.make({
  name: 'Morning check',
  files: [{ path: 'index.ts', content: 'export default {}' }],
})
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
    executor: Context.get(executor, Executor),
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
          const listed = yield* made.store.list(made.ownerActor)
          expect(listed.connections).toHaveLength(1)
          expect(listed.connections[0]).toHaveProperty('origin', 'Made')
          // Both Settings clients offer another account only for Catalogue origins.
          expect(listed.connections.some((connection) => connection.origin === 'Catalogue')).toBe(
            false,
          )
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
        expect(yield* made.make(request)).toEqual(
          MakeIntegrationOutcome.cases.Unreachable.make({
            reason: 'Integrations are unavailable. Try making it again later.',
          }),
        )
        expect(yield* made.store.records(made.ownerActor)).toEqual([])
        expect(yield* Ref.get(made.hosted.apps)).toEqual([])
      }),
    )

    for (const answer of ['disconnect', 'timeout', 'uncertain'] as const) {
      test.effect(`reclaims a committed app after a lost deploy answer (${answer})`, () =>
        Effect.gen(function* () {
          const made = yield* madeFixture()
          const saved = yield* Queue.unbounded<void>()
          const release = yield* Deferred.make<void>()
          // A timed-out request can still be running remotely. Release its work before the
          // fixture listener closes, including when an assertion fails.
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
          yield* Ref.set(made.hosted.apps, [{ id: 'unrelated', name: 'Another Connection' }])
          yield* Ref.set(made.hosted.afterWrite, (sent) =>
            Effect.gen(function* () {
              if (sent.path !== `POST ${hostedPrefix}/apps/deploy`) return
              yield* Queue.offer(saved, undefined)
              if (answer === 'timeout') {
                yield* Deferred.await(release)
                return
              }
              const incoming = yield* HttpServerRequest.HttpServerRequest
              if (answer === 'disconnect') {
                yield* Effect.sync(() =>
                  NodeHttpServerRequest.toIncomingMessage(incoming).socket.destroy(),
                )
                return
              }
              // A lost response can also arrive as an undecodable 5xx from an upstream proxy.
              const response = NodeHttpServerRequest.toServerResponse(incoming)
              yield* Effect.sync(() => {
                response.writeHead(503, { 'content-type': 'application/json' })
                response.end('{}')
              })
            }),
          )
          const attempt = yield* made.make(request).pipe(Effect.forkChild)
          yield* Queue.take(saved)
          if (answer === 'timeout') yield* TestClock.adjust('90 seconds')
          expect(yield* Fiber.join(attempt)).toEqual(
            MakeIntegrationOutcome.cases.Unreachable.make({
              reason: 'Integrations are unavailable. Try making it again later.',
            }),
          )
          yield* Deferred.succeed(release, undefined)
          expect(yield* made.store.records(made.ownerActor)).toEqual([])
          expect(yield* Ref.get(made.hosted.apps)).toEqual([
            { id: 'unrelated', name: 'Another Connection' },
          ])
          expect((yield* Ref.get(made.hosted.requests)).map((sent) => sent.path)).toContain(
            `DELETE ${hostedPrefix}/apps/app-2`,
          )
        }),
      )
    }

    test.effect(
      'rejects setup-required authorization and removes the app before any account starts',
      () =>
        Effect.gen(function* () {
          const made = yield* madeFixture()
          yield* Ref.set(made.hosted.accounts, {
            slot: {
              provider: 'provider',
              definition: { auth: { oauth: { type: 'oauth2' } } },
            },
          })
          yield* Ref.update(made.hosted.replies, (replies) =>
            new Map(replies).set(`GET ${hostedPrefix}/providers/provider/oauth/oauth/setup`, {
              status: 200,
              body: { clients: [], mode: 'client-required' },
            }),
          )
          const failure = yield* made.executor
            .make({
              connectionId: ConnectionId.make('setup-required'),
              service: ServiceId.make('made:setup-required'),
              owner: ExecutorOwnerId.make('p-test'),
              subject: made.ownerActor.person.id,
              label: request.name,
              returnAddress: 'https://vivid.example/api/connections/return',
              files: request.files,
            })
            .pipe(Effect.flip)
          expect(failure).toBeInstanceOf(ExecutorSetupRequired)
          expect(yield* Ref.get(made.hosted.apps)).toEqual([])
          expect(yield* made.make(request)).toEqual(
            MakeIntegrationOutcome.cases.NotAnIntegration.make({ reason: connectionSetupMessage }),
          )
          expect(yield* made.store.records(made.ownerActor)).toEqual([])
          expect(yield* Ref.get(made.hosted.apps)).toEqual([])
          expect(
            (yield* Ref.get(made.hosted.requests)).some(
              (sent) => sent.path.endsWith('/connections') && sent.path.startsWith('POST '),
            ),
          ).toBe(false)
        }),
    )

    for (const [tag, reason] of [
      [
        'AppEvaluationFailed',
        'The integration could not load its tools. Check its deployment and authorization.',
      ],
      ['BuildMemoryExceeded', 'This Integration could not be built within the available memory.'],
      ['SkillDefinitionInvalid', 'The imported service declaration is invalid.'],
    ] as const) {
      test.effect(`returns a repairable outcome for post-build ${tag}`, () =>
        Effect.gen(function* () {
          const made = yield* madeFixture()
          yield* Ref.update(made.hosted.replies, (replies) =>
            new Map(replies).set(`GET ${hostedPrefix}/apps/app/schedules/definitions`, {
              status: 422,
              body: { _tag: tag },
            }),
          )
          expect(yield* made.make(request)).toEqual(
            MakeIntegrationOutcome.cases.NotAnIntegration.make({ reason }),
          )
          expect(yield* made.store.records(made.ownerActor)).toEqual([])
          expect(yield* Ref.get(made.hosted.apps)).toEqual([])
        }),
      )
    }

    test.effect('keeps VersionBuildFailed on the ordinary add path as InvalidRequest', () =>
      Effect.gen(function* () {
        const made = yield* madeFixture()
        yield* Ref.update(made.hosted.replies, (replies) =>
          new Map(replies).set(`POST ${hostedPrefix}/apps/install`, {
            status: 422,
            body: BuildFailure.make({
              owner: 'host-owner',
              name: 'host-app',
              reason: 'compile',
              message: 'compiler detail',
            }),
          }),
        )
        const failure = yield* made.store
          .begin(made.ownerActor, {
            service: hostedService,
            name: null,
            shared: false,
            from: 'Web',
          })
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(InvalidRequest)
        expect(failure).toHaveProperty('message', 'The imported service could not be built.')
        expect(yield* made.store.records(made.ownerActor)).toEqual([])
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
