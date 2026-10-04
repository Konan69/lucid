import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import {
  Appearance,
  CompanyId,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DEFAULT_APPEARANCE,
  Forbidden,
  Look,
  Person,
  PersonId,
  SessionId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq, inArray } from 'drizzle-orm'
import { Effect, Layer, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { fixture } from '../approvals/testing.ts'
import { requireCompany, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, changesLayer, Topic } from '../live/changes.ts'
import { nextValue, observing, payload, silent } from '../live/testing.ts'
import { settingsStoreLayer } from '../settings/store.ts'
import { settingsTable } from '../settings/tables.ts'
import { appearanceHandlers } from './handlers.ts'
import { AppearanceOwner, AppearanceStore, appearanceStoreLayer } from './store.ts'

const testLayer = Layer.merge(appearanceStoreLayer, changesLayer).pipe(
  Layer.provideMerge(settingsStoreLayer),
  Layer.provideMerge(testDatabaseLayer),
)
const teal = new Appearance({
  name: 'Juno',
  look: Look.cases.Hue.make({ hue: 'cyan' }),
  outline: 'hexagon',
})
const at = 1_800_000_000_000

/** Handler tests retain the same signed-in authority provided by RPC middleware. */
const signedIn = (actor: Actor) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person: actor.person,
      workspace: actor.workspace,
      sessionId: SessionId.make('announcement-test'),
    }),
  )

/** Read without creating Settings: absence is part of the lazy-row rollback assertion. */
const settingsRows = Effect.fn('AppearanceAnnouncements.settingsRows')(function* (
  personId: PersonId,
) {
  const database = yield* Database
  return yield* database.run(
    database.select().from(settingsTable).where(eq(settingsTable.personId, personId)),
  )
})

/**
 * Brands permit this id: 1376 raw UTF-8 bytes become an 8082-byte JSON topic array.
 * PostgreSQL stores the real text key; its JSON-escaped topic exceeds the NOTIFY budget.
 * Only the real announce budget can fail after the write; no contract or SDK is altered.
 */
const unannounceablePerson = Effect.fn('AppearanceAnnouncements.unannounceablePerson')(
  function* () {
    const database = yield* Database
    const person = new Person({
      id: PersonId.make(`${crypto.randomUUID()}${'\u0001'.repeat(1_340)}`),
      name: 'Ada',
      email: `${crypto.randomUUID()}@announce.test`,
      image: null,
    })
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          database.run(database.delete(personTable).where(eq(personTable.id, person.id))),
        )
        expect(Result.isSuccess(result)).toBe(true)
      }),
    )
    yield* database.run(
      database
        .insert(personTable)
        .values({ id: person.id, name: person.name, email: person.email }),
    )
    const people = yield* database.run(
      database
        .select({ name: personTable.name })
        .from(personTable)
        .where(eq(personTable.id, person.id)),
    )
    expect(people).toEqual([{ name: 'Ada' }])
    expect(yield* settingsRows(person.id)).toEqual([])
    return person
  },
)

describe.skipIf(!testDatabaseConfigured)('appearance transaction announcements', () => {
  layer(testLayer)((it) => {
    it.effect('A1 a personal store write refreshes its owner and announces once', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* AppearanceStore
        const owner = AppearanceOwner.Person({ personId: test.personal.person.id })
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        const observation = yield* observing(
          [Topic.person(test.personal.person.id)],
          store.get(owner),
        )
        expect(observation.initial).toEqual(DEFAULT_APPEARANCE)
        expect(yield* store.set(owner, teal)).toEqual(teal)
        yield* payload(notices, [Topic.person(test.personal.person.id)])
        expect(yield* nextValue(observation)).toEqual(teal)
      }).pipe(Effect.scoped),
    )

    it.effect(
      'A2 a Company store write refreshes the Company and preserves personal appearance',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* AppearanceStore
          const owner = AppearanceOwner.Company({
            companyId: (yield* requireCompany(test.owner.workspace)).company.id,
          })
          const notices = yield* (yield* PgClient).listen(CHANNEL)
          const observation = yield* observing([Topic.company(owner.companyId)], store.get(owner))
          expect(observation.initial).toEqual(DEFAULT_APPEARANCE)
          expect(yield* store.set(owner, teal)).toEqual(teal)
          yield* payload(notices, [Topic.company(owner.companyId)])
          expect(yield* nextValue(observation)).toEqual(teal)
          expect(
            yield* store.get(AppearanceOwner.Person({ personId: test.other.person.id })),
          ).toEqual(DEFAULT_APPEARANCE)
        }).pipe(Effect.scoped),
    )

    it.effect('A3 lazy Settings keep their defaults and the controlled write time', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const personId = test.personal.person.id
        expect(yield* settingsRows(personId)).toEqual([])
        yield* TestClock.setTime(at)
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        expect(
          yield* (yield* AppearanceStore).set(AppearanceOwner.Person({ personId }), teal),
        ).toEqual(teal)
        const rows = yield* settingsRows(personId)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          theme: 'system',
          timezone: 'UTC',
          notify: true,
          updatedAt: new Date(at),
        })
        yield* payload(notices, [Topic.person(personId)])
      }).pipe(Effect.scoped),
    )

    it.effect('A4 a Company handler announces only the stored Company owner', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const owner = AppearanceOwner.Company({
          companyId: (yield* requireCompany(test.owner.workspace)).company.id,
        })
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        expect(yield* appearanceHandlers.SetAppearance(teal).pipe(signedIn(test.owner))).toEqual(
          teal,
        )
        yield* payload(notices, [Topic.company(owner.companyId)])
      }).pipe(Effect.scoped),
    )

    it.effect('A5 denied and missing owners preserve rows and emit nothing', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const store = yield* AppearanceStore
        const owner = AppearanceOwner.Company({
          companyId: (yield* requireCompany(test.owner.workspace)).company.id,
        })
        const before = yield* store.get(owner)
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        expect(
          yield* appearanceHandlers.SetAppearance(teal).pipe(signedIn(test.member), Effect.flip),
        ).toBeInstanceOf(Forbidden)
        yield* silent(notices)
        expect(yield* store.get(owner)).toEqual(before)
        expect(yield* settingsRows(test.personal.person.id)).toEqual([])
        expect(
          yield* store
            .set(AppearanceOwner.Company({ companyId: CompanyId.make(crypto.randomUUID()) }), teal)
            .pipe(Effect.flip),
        ).toBeInstanceOf(DatabaseFailure)
        yield* silent(notices)
        expect(yield* store.get(owner)).toEqual(before)
        const missing = PersonId.make(crypto.randomUUID())
        expect(
          yield* store.set(AppearanceOwner.Person({ personId: missing }), teal).pipe(Effect.flip),
        ).toBeInstanceOf(DatabaseConstraintViolation)
        yield* silent(notices)
        expect(yield* store.get(owner)).toEqual(before)
        expect(
          yield* database.run(
            database
              .select()
              .from(settingsTable)
              .where(
                inArray(settingsTable.personId, [
                  test.personal.person.id,
                  test.other.person.id,
                  missing,
                ]),
              ),
          ),
        ).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect('AF a real payload rejection rolls back the lazy Settings row and stays silent', () =>
      Effect.gen(function* () {
        const person = yield* unannounceablePerson()
        const notices = yield* (yield* PgClient).listen(CHANNEL)
        const result = yield* Effect.result(
          (yield* AppearanceStore).set(AppearanceOwner.Person({ personId: person.id }), teal),
        )
        // A successful result or surviving row here would show that the write escaped rollback.
        expect({
          result: Result.match(result, {
            onSuccess: (appearance) => ({ outcome: 'Success', appearance }),
            onFailure: (error) => ({ outcome: error._tag, message: error.message }),
          }),
          storedNames: (yield* settingsRows(person.id)).map((row) => row.vividName),
        }).toEqual({
          result: {
            outcome: 'DatabaseFailure',
            message: 'Change notification exceeds its payload limit',
          },
          storedNames: [],
        })
        yield* silent(notices)
      }).pipe(Effect.scoped),
    )
  })
})
