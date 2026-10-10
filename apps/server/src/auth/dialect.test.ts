import * as NodeCrypto from 'node:crypto'
import { Database as AuthDatabase } from '@alchemy.run/better-auth/Database'
import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import { eq, inArray } from 'drizzle-orm'
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from 'effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import { Kysely } from 'kysely'
import { DatabaseFailure, PersonId, SessionId } from '@vivid/contracts'
import { ServerConfig } from '../config.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { announce, CHANNEL, Changes, changesLayer, Topic } from '../live/changes.ts'
import { sessionEnded } from '../live/query.ts'
import { authDatabaseLayer, SessionOwnerUnreadable, UnrecognisedDelete } from './dialect.ts'
import { authEffect, localAuthRuntimeLayer, type AuthInstance } from './provider.ts'
import { sessionWorkspace } from './session.ts'
import { personTable, sessionTable } from './tables.ts'

/**
 * Session removal through the real seam: the public Better Auth instance that Alchemy builds over
 * `authDatabaseLayer`, real PostgreSQL, and the real change bus. Nothing is mocked. What a removal
 * announced is read from a raw `LISTEN` on the change channel and bounded by a later committed
 * marker, so "nothing was announced" is an ordered observation, never a wait for silence.
 */
const testLayer = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  changesLayer.pipe(Layer.provide(testDatabaseLayer)),
  localAuthRuntimeLayer,
)

const origin = 'http://127.0.0.1:8787'
const json = { 'content-type': 'application/json', origin }
const decodeTopics = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/** A deliberate failure inside a Better Auth transaction, to make it roll back. */
class RemovalAbandoned extends Schema.TaggedError<RemovalAbandoned>()(
  'RemovalAbandoned',
  {},
  { title: 'Abandoned test removal' },
) {}

/** One request to the production auth routes, on the instance under test. */
const call = (auth: AuthInstance, path: string, init: RequestInit) =>
  auth.fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(`${origin}/api/auth/${path}`, init)),
    ),
  )

/** Better Auth's own context: the official adapter, reached through the public `$context`. */
const adapterOf = Effect.fn('DialectTest.adapterOf')(function* (auth: AuthInstance) {
  const instance = yield* auth.auth
  const context = yield* Effect.promise(() => instance.$context)
  return context.adapter
})

/** Preserve the original adapter rejection as the success value without an unknown error channel. */
class AdapterRejected extends Schema.TaggedError<AdapterRejected>()(
  'AdapterRejected',
  {
    cause: Schema.Unknown,
  },
  { title: 'Test adapter rejected the operation' },
) {}

/** A Promise of the official adapter, with its rejection as the value under test. */
const rejection = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new AdapterRejected({ cause }) }).pipe(
    Effect.flip,
    Effect.map((failure) => failure.cause),
  )

/** Removes a fixture Person and, by cascade, their sessions. Registered before the first write. */
const forgetting = Effect.fn('DialectTest.forgetting')(function* (ids: ReadonlyArray<string>) {
  const database = yield* Database
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(inArray(personTable.id, [...ids]))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Dialect fixture cleanup failed'))),
    ),
  )
})

/** People with one stored session each, written directly: they are fixtures, not the behaviour. */
const peopleWithSessions = Effect.fn('DialectTest.peopleWithSessions')(function* (
  ids: ReadonlyArray<string>,
  sessionsEach: number,
) {
  const database = yield* Database
  yield* forgetting(ids)
  yield* database.run(
    database.insert(personTable).values(
      ids.map((id) => ({
        id,
        name: 'Dialect test',
        email: `${NodeCrypto.randomUUID()}@example.test`,
      })),
    ),
  )
  const sessions = ids.flatMap((userId) =>
    Array.from({ length: sessionsEach }, () => ({
      id: NodeCrypto.randomUUID(),
      token: NodeCrypto.randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })),
  )
  yield* database.run(database.insert(sessionTable).values(sessions))
  return sessions
})

/** Signs up through the production route and returns the stored Person, session and cookie. */
const signedUp = Effect.fn('DialectTest.signedUp')(function* (auth: AuthInstance) {
  const database = yield* Database
  const email = `${NodeCrypto.randomUUID()}@example.test`
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.email, email))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Dialect fixture cleanup failed'))),
    ),
  )
  const response = yield* call(auth, 'sign-up/email', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email, name: 'Dialect test', password: 'test-Dialect-0123456789' }),
  })
  expect(response.status).toBe(200)
  const cookie = Object.values(response.cookies.cookies)
    .map((entry) => `${entry.name}=${entry.valueEncoded}`)
    .join('; ')
  const [row] = yield* database.run(
    database
      .select({ personId: personTable.id, sessionId: sessionTable.id })
      .from(sessionTable)
      .innerJoin(personTable, eq(personTable.id, sessionTable.userId))
      .where(eq(personTable.email, email)),
  )
  if (row === undefined) return expect.fail('Sign-up must persist a Person and a session')
  return {
    personId: PersonId.make(row.personId),
    sessionId: SessionId.make(row.sessionId),
    cookie,
  }
})

/** The session rows a Person still has. */
const sessionsOf = Effect.fn('DialectTest.sessionsOf')(function* (ids: ReadonlyArray<string>) {
  const database = yield* Database
  return yield* database.run(
    database
      .select({ id: sessionTable.id, userId: sessionTable.userId })
      .from(sessionTable)
      .where(inArray(sessionTable.userId, [...ids])),
  )
})

/**
 * Commits a marker announcement and returns every topic batch that reached the listener before
 * it. PostgreSQL delivers notifications in commit order, so this is everything earlier commits
 * announced and nothing later.
 */
const announcedSoFar = Effect.fn('DialectTest.announcedSoFar')(function* (
  notifications: Effect.Success<ReturnType<PgClient['listen']>>,
) {
  const database = yield* Database
  const marker = [Topic.person(PersonId.make(NodeCrypto.randomUUID()))]
  yield* database.transaction((transaction) => announce(transaction, marker))
  return yield* Stream.fromQueue(notifications).pipe(
    Stream.takeWhile((notification) => notification.payload !== JSON.stringify(marker)),
    Stream.mapEffect((notification) => decodeTopics(notification.payload)),
    Stream.runCollect,
  )
})

/** A Kysely over the very dialect `authDatabaseLayer` hands Better Auth, for statements it never writes. */
const dialectKysely = Effect.fn('DialectTest.dialectKysely')(function* () {
  const config = yield* ServerConfig
  const input = yield* Effect.gen(function* () {
    return yield* (yield* AuthDatabase).runtime
  }).pipe(
    Effect.provide(
      yield* Layer.build(
        authDatabaseLayer(config.DATABASE_URL).pipe(Layer.provide(localAuthRuntimeLayer)),
      ),
    ),
  )
  if (!('dialect' in input)) return expect.fail('The auth database must be the dialect form')
  return new Kysely<{ session: typeof sessionTable.$inferSelect }>({ dialect: input.dialect })
})

describe.skipIf(!testDatabaseConfigured)('Session removal announces in its own commit', () => {
  // Real time: Better Auth reads the wall clock for expiry and `watch` debounces on a real timer,
  // so the suite runs without the test clock (`excludeTestServices`, @effect/vitest rc.116).
  layer(testLayer, { excludeTestServices: true })((it) => {
    /** The public sign-out deletes one row; the Person's topic moves and a session watch ends. */
    it.effect('signing out announces the Person and ends a watch on that session', () =>
      Effect.gen(function* () {
        const auth = yield* authEffect
        const ada = yield* signedUp(auth)
        const changes = yield* Changes
        const moved = yield* changes.subscribe([Topic.person(ada.personId)])
        const ended = yield* sessionEnded(ada.personId, ada.sessionId).pipe(Effect.forkScoped)
        const signedOut = yield* call(auth, 'sign-out', {
          method: 'POST',
          headers: { ...json, cookie: ada.cookie },
          body: '{}',
        })
        expect(signedOut.status).toBe(200)
        expect(Option.isSome(yield* Stream.runHead(moved))).toBe(true)
        const failure = yield* Fiber.join(ended).pipe(Effect.flip)
        expect(failure._tag).toBe('Unauthenticated')
      }).pipe(Effect.scoped),
    )

    /** Revoking the others removes them by token; the caller's own session is left and unannounced beyond its Person. */
    it.effect('revoking other sessions ends them and keeps the session that asked', () =>
      Effect.gen(function* () {
        const auth = yield* authEffect
        const ada = yield* signedUp(auth)
        const database = yield* Database
        const other = {
          id: NodeCrypto.randomUUID(),
          token: NodeCrypto.randomUUID(),
          userId: ada.personId,
          expiresAt: new Date(Date.now() + 3_600_000),
        }
        yield* database.run(database.insert(sessionTable).values(other))
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const revoked = yield* call(auth, 'revoke-other-sessions', {
          method: 'POST',
          headers: { ...json, cookie: ada.cookie },
          body: '{}',
        })
        expect(revoked.status).toBe(200)
        expect(yield* announcedSoFar(notifications)).toEqual([[Topic.person(ada.personId)]])
        expect(yield* sessionsOf([ada.personId])).toEqual([
          { id: ada.sessionId, userId: ada.personId },
        ])
        const gone = yield* sessionWorkspace(ada.personId, SessionId.make(other.id)).pipe(
          Effect.flip,
        )
        expect(gone._tag).toBe('Unauthenticated')
        expect((yield* sessionWorkspace(ada.personId, ada.sessionId))._tag).toBe('Personal')
      }).pipe(Effect.scoped),
    )

    /** The hook this replaces read at most 100 rows; one statement here removes and announces them all. */
    it.effect('revoking every session of a Person removes more than a hundred in one notice', () =>
      Effect.gen(function* () {
        const auth = yield* authEffect
        const ada = yield* signedUp(auth)
        const database = yield* Database
        yield* database.run(
          database.insert(sessionTable).values(
            Array.from({ length: 150 }, () => ({
              id: NodeCrypto.randomUUID(),
              token: NodeCrypto.randomUUID(),
              userId: ada.personId,
              expiresAt: new Date(Date.now() + 3_600_000),
            })),
          ),
        )
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const revoked = yield* call(auth, 'revoke-sessions', {
          method: 'POST',
          headers: { ...json, cookie: ada.cookie },
          body: '{}',
        })
        expect(revoked.status).toBe(200)
        expect(yield* sessionsOf([ada.personId])).toEqual([])
        expect(yield* announcedSoFar(notifications)).toEqual([[Topic.person(ada.personId)]])
      }).pipe(Effect.scoped),
    )

    /** Owners come from the rows the statement removed: both of them, and not a bystander. */
    it.effect('one statement removing two People’s sessions announces exactly those two', () =>
      Effect.gen(function* () {
        const ada = NodeCrypto.randomUUID()
        const grace = NodeCrypto.randomUUID()
        const bystander = NodeCrypto.randomUUID()
        yield* peopleWithSessions([ada, grace, bystander], 2)
        const adapter = yield* adapterOf(yield* authEffect)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const removed = yield* Effect.promise(() =>
          adapter.deleteMany({
            model: 'session',
            where: [{ field: 'userId', operator: 'in', value: [ada, grace] }],
          }),
        )
        expect(removed).toBe(4)
        const batches = yield* announcedSoFar(notifications)
        expect(batches).toHaveLength(1)
        expect(batches.flat().toSorted()).toEqual(
          [ada, grace].map((id) => Topic.person(PersonId.make(id))).toSorted(),
        )
        expect((yield* sessionsOf([ada, grace, bystander])).map((row) => row.userId)).toEqual([
          bystander,
          bystander,
        ])
      }).pipe(Effect.scoped),
    )

    /** More owners than the old 100-row read: every one is announced, none twice. */
    it.effect('one statement removing sessions of more than a hundred People announces all', () =>
      Effect.gen(function* () {
        const ids = Array.from({ length: 150 }, () => NodeCrypto.randomUUID())
        yield* peopleWithSessions(ids, 1)
        const adapter = yield* adapterOf(yield* authEffect)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const removed = yield* Effect.promise(() =>
          adapter.deleteMany({
            model: 'session',
            where: [{ field: 'userId', operator: 'in', value: ids }],
          }),
        )
        expect(removed).toBe(150)
        expect((yield* announcedSoFar(notifications)).flat().toSorted()).toEqual(
          ids.map((id) => Topic.person(PersonId.make(id))).toSorted(),
        )
        expect(yield* sessionsOf(ids)).toEqual([])
      }).pipe(Effect.scoped),
    )

    /** An owner that cannot fit a payload refuses the removal: the row stays and nothing is said. */
    it.effect('a removal whose notice cannot be built fails and keeps the session', () =>
      Effect.gen(function* () {
        const unrepresentable = 'x'.repeat(8_000)
        yield* peopleWithSessions([unrepresentable], 1)
        const adapter = yield* adapterOf(yield* authEffect)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* rejection(() =>
          adapter.deleteMany({
            model: 'session',
            where: [{ field: 'userId', value: unrepresentable }],
          }),
        )
        expect(failure).toBeInstanceOf(DatabaseFailure)
        expect(yield* sessionsOf([unrepresentable])).toHaveLength(1)
        expect(yield* announcedSoFar(notifications)).toEqual([])
      }).pipe(Effect.scoped),
    )

    /** Inside Better Auth's own transaction the removal joins it, so its rollback takes the notice too. */
    it.effect('a removal inside a Better Auth transaction that fails is not announced', () =>
      Effect.gen(function* () {
        const ada = NodeCrypto.randomUUID()
        yield* peopleWithSessions([ada], 1)
        const adapter = yield* adapterOf(yield* authEffect)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* rejection(() =>
          adapter.transaction((transaction) =>
            transaction
              .deleteMany({ model: 'session', where: [{ field: 'userId', value: ada }] })
              .then(() => Promise.reject(new RemovalAbandoned({}))),
          ),
        )
        expect(failure).toBeInstanceOf(RemovalAbandoned)
        expect(yield* sessionsOf([ada])).toHaveLength(1)
        expect(yield* announcedSoFar(notifications)).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('a removal inside a Better Auth transaction that commits is announced once', () =>
      Effect.gen(function* () {
        const ada = NodeCrypto.randomUUID()
        yield* peopleWithSessions([ada], 1)
        const adapter = yield* adapterOf(yield* authEffect)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const removed = yield* Effect.promise(() =>
          adapter.transaction((transaction) =>
            transaction.deleteMany({ model: 'session', where: [{ field: 'userId', value: ada }] }),
          ),
        )
        expect(removed).toBe(1)
        expect(yield* sessionsOf([ada])).toEqual([])
        expect(yield* announcedSoFar(notifications)).toEqual([[Topic.person(PersonId.make(ada))]])
      }).pipe(Effect.scoped),
    )

    /** No row, no owner, no notice; the official result is unchanged. */
    it.effect('a removal that matches nothing announces nothing', () =>
      Effect.gen(function* () {
        const adapter = yield* adapterOf(yield* authEffect)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const removed = yield* Effect.promise(() =>
          adapter.deleteMany({
            model: 'session',
            where: [{ field: 'userId', value: NodeCrypto.randomUUID() }],
          }),
        )
        expect(removed).toBe(0)
        expect(yield* announcedSoFar(notifications)).toEqual([])
      }).pipe(Effect.scoped),
    )

    /** `consumeOne` already returns its row; the owner announced is the row PostgreSQL removed. */
    it.effect('consuming one of two candidate sessions announces only the one removed', () =>
      Effect.gen(function* () {
        const ada = NodeCrypto.randomUUID()
        const grace = NodeCrypto.randomUUID()
        yield* peopleWithSessions([ada, grace], 1)
        const adapter = yield* adapterOf(yield* authEffect)
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const consumed = yield* Effect.promise(() =>
          adapter.consumeOne<{ readonly id: string; readonly userId: string }>({
            model: 'session',
            where: [{ field: 'userId', operator: 'in', value: [ada, grace] }],
          }),
        )
        if (consumed === null) return expect.fail('One candidate session must be consumed')
        expect(yield* announcedSoFar(notifications)).toEqual([
          [Topic.person(PersonId.make(consumed.userId))],
        ])
        const kept = yield* sessionsOf([ada, grace])
        expect(kept).toHaveLength(1)
        expect(kept.map((row) => row.userId)).not.toContain(consumed.userId)
        return undefined
      }).pipe(Effect.scoped),
    )

    /** Better Auth never aliases the table. If a statement does, it is refused, not passed unannounced. */
    it.effect('an aliased delete on the session table is refused and removes nothing', () =>
      Effect.gen(function* () {
        const ada = NodeCrypto.randomUUID()
        yield* peopleWithSessions([ada], 1)
        const kysely = yield* dialectKysely()
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* rejection(() =>
          kysely.deleteFrom('session as s').where('s.userId', '=', ada).execute(),
        )
        expect(failure).toBeInstanceOf(UnrecognisedDelete)
        expect(yield* sessionsOf([ada])).toHaveLength(1)
        expect(yield* announcedSoFar(notifications)).toEqual([])
      }).pipe(Effect.scoped),
    )

    /** A `returning` without the owner column cannot be announced, so it must not commit. */
    it.effect('a removal whose returned rows do not name the owner is refused', () =>
      Effect.gen(function* () {
        const ada = NodeCrypto.randomUUID()
        yield* peopleWithSessions([ada], 1)
        const kysely = yield* dialectKysely()
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* rejection(() =>
          kysely.deleteFrom('session').where('userId', '=', ada).returning('id').execute(),
        )
        expect(failure).toBeInstanceOf(SessionOwnerUnreadable)
        expect(yield* sessionsOf([ada])).toHaveLength(1)
        expect(yield* announcedSoFar(notifications)).toEqual([])
      }).pipe(Effect.scoped),
    )

    /**
     * The pool has one client, so the next statement runs on the connection the failed removal
     * used. Had its rollback not run, that connection would still hold the failed delete and the
     * next removal's commit would take the first session with it.
     */
    it.effect('a failed removal rolls back and leaves its connection usable', () =>
      Effect.gen(function* () {
        const unrepresentable = 'y'.repeat(8_000)
        const ada = NodeCrypto.randomUUID()
        yield* peopleWithSessions([unrepresentable, ada], 1)
        const kysely = yield* dialectKysely()
        const notifications = yield* (yield* PgClient).listen(CHANNEL)
        const failure = yield* rejection(() =>
          kysely.deleteFrom('session').where('userId', '=', unrepresentable).execute(),
        )
        expect(failure).toBeInstanceOf(DatabaseFailure)
        const [removed] = yield* Effect.promise(() =>
          kysely.deleteFrom('session').where('userId', '=', ada).execute(),
        )
        if (removed === undefined) return expect.fail('The second removal must report a result')
        expect(removed.numDeletedRows).toBe(1n)
        expect(yield* announcedSoFar(notifications)).toEqual([[Topic.person(PersonId.make(ada))]])
        expect((yield* sessionsOf([unrepresentable, ada])).map((row) => row.userId)).toEqual([
          unrepresentable,
        ])
        return undefined
      }).pipe(Effect.scoped),
    )

    /**
     * Better Auth finds its schema check by the identity of the official adapter object, so the
     * check still running proves that object is the one in place. The column is dropped in this
     * file's disposable database and put back by a finalizer registered before the change. Last in
     * the file: a changed table invalidates plans cached by earlier connections.
     */
    it.effect('a schema that lacks an auth column still fails the auth request', () =>
      Effect.gen(function* () {
        const sql = yield* PgClient
        yield* Effect.addFinalizer(() =>
          sql`ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "ipAddress" text`.pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.sync(() => expect.fail('Schema fixture cleanup failed'))),
          ),
        )
        yield* sql`ALTER TABLE "session" DROP COLUMN "ipAddress"`
        const exit = yield* call(yield* authEffect, 'ok', {
          method: 'GET',
          headers: { origin },
        }).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) return expect.fail('A mismatched schema must fail the request')
        // Better Auth's own check rejects the request; the Alchemy bridge surfaces it as a defect.
        expect(String(Cause.squash(exit.cause))).toContain('Database schema mismatch')
        return undefined
      }).pipe(Effect.scoped),
    )
  })
})
