import { describe, expect, layer } from '@effect/vitest'
import {
  Forbidden,
  Person,
  PersonId,
  PersonName,
  SessionId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq } from 'drizzle-orm'
import { Effect, Fiber, Layer, Option, Queue, Result, Schema, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { findPerson } from './access.ts'
import { personTable, sessionTable } from './tables.ts'
import { companyHandlers } from '../companies/handlers.ts'
import { companyStoreLayer } from '../companies/store.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, changesLayer, everyPart, Topic } from '../live/changes.ts'
import { LiveTally, makeTally } from '../live/tally.ts'

const testLayer = Layer.mergeAll(
  companyStoreLayer,
  changesLayer,
  Layer.succeed(LiveTally, makeTally()),
).pipe(Layer.provideMerge(testDatabaseLayer))

const decodeName = Schema.decodeUnknownEffect(PersonName)

/** One signed-in Person with a real session row, removed with everything under it afterwards. */
const fixture = Effect.fn('PersonName.fixture')(function* () {
  const database = yield* Database
  const person = new Person({
    id: PersonId.make(crypto.randomUUID()),
    name: 'Ada Lovelace',
    email: `${crypto.randomUUID()}@example.test`,
    image: null,
  })
  const sessionId = SessionId.make(crypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, person.id))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Person name fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: person.id, name: person.name, email: person.email, emailVerified: true }),
  )
  yield* database.run(
    database.insert(sessionTable).values({
      id: sessionId,
      userId: person.id,
      token: crypto.randomUUID(),
      expiresAt: new Date('2100-01-01T00:00:00Z'),
    }),
  )
  const signedIn = Effect.provideService(
    AuthContext,
    AuthState.Person({ person, sessionId, workspace: Workspace.cases.Personal.make({}) }),
  )
  // Vivid in a Run reads the name the way the runtime does at the start of each response.
  const vivid = Effect.provideService(
    AuthContext,
    AuthState.Vivid({
      person,
      workspace: Workspace.cases.Personal.make({}),
      threadId: ThreadId.make(crypto.randomUUID()),
    }),
  )
  return { person, signedIn, vivid }
})

/** The Person's own name: set in Settings, read back by every screen and by Vivid. */
describe.skipIf(!testDatabaseConfigured)('a Person’s name', () => {
  layer(testLayer)((it) => {
    it.effect('a Person renames themselves and Vivid reads the new name', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const name = yield* decodeName('Ada')
        const saved = yield* companyHandlers.SetPersonName({ name }).pipe(test.signedIn)
        expect(saved.person.name).toBe('Ada')
        const stored = yield* findPerson(test.person.id)
        expect(Option.getOrThrow(stored).name).toBe('Ada')
        // The runtime's AuthState carries the Person as it was when the Run began; `Me` reads
        // the name from the row, so Vivid's next response is told the new one.
        const read = yield* companyHandlers.Me().pipe(test.vivid)
        expect(read.person.name).toBe('Ada')
      }).pipe(Effect.scoped),
    )

    it.effect('an open WatchMe answers again with the new name', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const answers = yield* Queue.unbounded<string>()
        const watching = yield* companyHandlers.WatchMe().pipe(
          Stream.runForEach((me) => Queue.offer(answers, me.person.name)),
          test.signedIn,
          Effect.forkScoped,
        )
        // The first answer is sent after the subscription is open (`live/query.ts` `watch`), so
        // the rename below cannot be missed.
        expect(yield* Queue.take(answers)).toBe('Ada Lovelace')
        // A second, real subscription hears the PostgreSQL notice; only then is the test clock
        // moved past the live query's 20 ms coalescing window (`CHANGE_COALESCENCE`).
        const heard = yield* (yield* Changes).subscribe([Topic.person(test.person.id)], everyPart)
        yield* companyHandlers
          .SetPersonName({ name: yield* decodeName('Countess') })
          .pipe(test.signedIn)
        expect(Option.isSome(yield* Stream.runHead(heard))).toBe(true)
        yield* TestClock.adjust('20 millis')
        const next = yield* Effect.raceFirst(
          Queue.take(answers),
          Fiber.join(watching).pipe(Effect.andThen(Effect.never)),
        )
        expect(next).toBe('Countess')
        yield* Fiber.interrupt(watching)
      }).pipe(Effect.scoped),
    )

    it.effect('Vivid cannot rename the Person it works for', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const refused = yield* Effect.result(
          companyHandlers.SetPersonName({ name: yield* decodeName('Bot') }).pipe(test.vivid),
        )
        expect(Result.isFailure(refused)).toBe(true)
        if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(Forbidden)
        const stored = yield* findPerson(test.person.id)
        expect(Option.getOrThrow(stored).name).toBe('Ada Lovelace')
      }).pipe(Effect.scoped),
    )
  })
})
