import * as NodeCrypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, layer } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcMiddleware from 'effect/unstable/rpc/RpcMiddleware'
import * as RpcTest from 'effect/unstable/rpc/RpcTest'
import { PersonId, SessionId } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { RpcAuthMiddleware, RpcFailure } from '@vivid/contracts/rpc'
import { ServerConfig } from '../config.ts'
import { Database, decodeStored } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { rpcAuthMiddlewareLayer } from './middleware.ts'
import { personTable, sessionTable } from './tables.ts'

const applicationName = `vivid-auth-${NodeCrypto.randomBytes(8).toString('hex')}`
const Caller = Schema.TaggedUnion({ Person: { personId: PersonId }, Vivid: {}, Runtime: {} })
const ProbeResult = Schema.Struct({ caller: Caller, pids: Schema.Array(Schema.Int) })
/**
 * `pg_stat_activity` rows are database ingress, so `decodeStored` (database/client.ts) decodes
 * them and reports a misfit as the `DatabaseFailure` that Probe's `RpcFailure` declares. A bare
 * `Schema.decodeUnknownEffect` put `SchemaError` in the handler's error channel, which the RPC
 * contract does not carry. Built once here so every probe reuses the same decoder.
 */
const decodeBackends = decodeStored(
  Schema.Struct({ rows: Schema.Array(Schema.Struct({ pid: Schema.Int })) }),
  'Better Auth backend list',
)

/** A receipt observes the real RPC request's last finalizer, without replacing authentication. */
class Receipts extends Context.Service<Receipts, Queue.Queue<void>>()('AuthScopeTest/Receipts') {}

/** Added last to the RPC so its finalizer registers first and runs after the SDK pool finalizer. */
class Closed extends RpcMiddleware.Service<Closed>()('AuthScopeTest/Closed') {}

const probes = RpcGroup.make(
  Rpc.make('Probe', { success: ProbeResult, error: RpcFailure })
    .middleware(RpcAuthMiddleware)
    .middleware(Closed),
)

/** Only the Better Auth pool receives this startup label; the product test database remains unchanged. */
const authConfigLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const address = new URL(Redacted.value(config.DATABASE_URL))
    address.searchParams.set('application_name', applicationName)
    return Layer.succeed(ServerConfig, {
      ...config,
      DATABASE_URL: Redacted.make(address.href),
    })
  }),
).pipe(Layer.provide(testConfigLayer))

/** Read the actual SDK backends in this file's disposable database; no timing or pool mock is involved. */
const authBackends = Effect.fn('AuthScopeTest.backends')(function* () {
  const database = yield* Database
  const receipt = yield* database.run(
    database.execute(sql`
    SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${applicationName}
  `),
  )
  return (yield* decodeBackends(receipt)).rows.map((row) => row.pid)
})

/** A real handler observes auth's connection while the RpcServer request scope is still open. */
const handlers = probes.toLayer({
  Probe: Effect.fn('AuthScopeTest.probe')(function* () {
    const auth = yield* AuthContext
    const caller = AuthState.$match(auth, {
      Person: (person) => Caller.cases.Person.make({ personId: person.person.id }),
      Vivid: () => Caller.cases.Vivid.make({}),
      Runtime: () => Caller.cases.Runtime.make({}),
    })
    return ProbeResult.make({ caller, pids: yield* authBackends() })
  }),
})

/** RpcServer.ts applyMiddleware wraps in insertion order; this outer observer registers before auth. */
const closedLayer = Layer.effect(
  Closed,
  Effect.gen(function* () {
    const receipts = yield* Receipts
    return (effect) =>
      Effect.addFinalizer(() => Queue.offer(receipts, undefined)).pipe(Effect.andThen(effect))
  }),
)

const dependencies = Layer.mergeAll(
  testDatabaseLayer,
  authConfigLayer,
  Layer.effect(Receipts, Queue.unbounded<void>()),
)
const testLayer = Layer.mergeAll(handlers, closedLayer, rpcAuthMiddlewareLayer).pipe(
  Layer.provideMerge(dependencies),
)

/** Cleanup precedes inserts; the real bearer plugin resolves this unexpired session into a Person. */
const personSession = Effect.fn('AuthScopeTest.personSession')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const sessionId = SessionId.make(NodeCrypto.randomUUID())
  const token = NodeCrypto.randomUUID()
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, personId))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Auth scope fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database.insert(personTable).values({
      id: personId,
      name: 'Auth scope test',
      email: `${personId}@example.test`,
    }),
  )
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: personId,
      token,
      expiresAt: new Date((yield* Clock.currentTimeMillis) + 86_400_000),
    }),
  )
  return { personId, token }
})

describe.skipIf(!testDatabaseConfigured)('RPC authentication resource ownership', () => {
  layer(testLayer, { excludeTestServices: true })((it) => {
    /** Runtime authority bypasses Better Auth, even through the same real RpcServer machinery. */
    it.effect('the runtime token opens no Better Auth connection', () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig
        const receipts = yield* Receipts
        const client = yield* RpcTest.makeClient(probes)
        const result = yield* client.Probe(undefined, {
          headers: { authorization: `Bearer ${Redacted.value(config.RUNTIME_TOKEN)}` },
        })
        expect(result).toEqual({ caller: Caller.cases.Runtime.make({}), pids: [] })
        yield* Queue.take(receipts)
      }),
    )

    /** Request closure must end the SDK pool while the middleware Layer remains available for the next call. */
    it.effect('a Person call releases its auth connection and the middleware keeps serving', () =>
      Effect.gen(function* () {
        const person = yield* personSession()
        const receipts = yield* Receipts
        const client = yield* RpcTest.makeClient(probes)
        const options = { headers: { authorization: `Bearer ${person.token}` } }
        const expected = Caller.cases.Person.make({ personId: person.personId })
        const first = yield* client.Probe(undefined, options)
        expect(first.caller).toEqual(expected)
        expect(first.pids.length).toBeGreaterThan(0)
        yield* Queue.take(receipts)
        expect(yield* authBackends()).toEqual([])
        const second = yield* client.Probe(undefined, options)
        expect(second.caller).toEqual(expected)
        expect(second.pids.length).toBeGreaterThan(0)
        yield* Queue.take(receipts)
        expect(yield* authBackends()).toEqual([])
      }),
    )
  })
})
