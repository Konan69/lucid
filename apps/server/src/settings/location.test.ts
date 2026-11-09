import { describe, expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as NodeCrypto from 'node:crypto'
import {
  Forbidden,
  LocationNotShared,
  LocationReading,
  LocationSharing,
  PatchSettingsRequest,
  SessionId,
  ShareLocationRequest,
  ThreadId,
  Workspace,
  type Person,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { contextInstruction, emptyContext, locatedAt } from '@vivid/agent-runtime/context'
import { fixture, trustTestLayer } from '../approvals/testing.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { locationHandlers, settingsHandlers } from './handlers.ts'
import { settingsStoreLayer } from './store.ts'

const testLayer = settingsStoreLayer.pipe(Layer.provideMerge(trustTestLayer))

const MINUTE = 60_000

/** The Person's own phone, as the RPC middleware hands a signed-in session over. */
const onPhone = (person: Person) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person,
      workspace: Workspace.cases.Personal.make({}),
      sessionId: SessionId.make('phone-session'),
    }),
  )

/** Vivid in a Run for the same Person: it reads Settings for a response's context. */
const asVivid = (person: Person) =>
  Effect.provideService(
    AuthContext,
    AuthState.Vivid({
      person,
      workspace: Workspace.cases.Personal.make({}),
      threadId: ThreadId.make(NodeCrypto.randomUUID()),
    }),
  )

/** What a response is told, rendered by the runtime from Settings as Vivid read them. */
const told = (location: LocationSharing, readAt: number) =>
  contextInstruction({
    ...emptyContext,
    asOf: Option.some(readAt),
    location: locatedAt(location, readAt),
  })

describe.skipIf(!testDatabaseConfigured)('Sharing where the Person is', () => {
  layer(testLayer)((it) => {
    it.effect(
      'is off until turned on, kept per Person, told to Vivid with its age, and forgotten when turned off',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const person = test.personal.person
          const takenAt = Date.UTC(2026, 10, 9, 18, 0)
          const lekki = new LocationReading({
            latitude: 6.4474,
            longitude: 3.4723,
            accuracy: 1200,
            takenAt,
            place: 'Lekki, Lagos, Nigeria',
          })
          const share = locationHandlers.ShareLocation(new ShareLocationRequest({ reading: lekki }))

          // Off by default: a reading is refused, nothing is kept and Vivid is told nothing.
          const first = yield* settingsHandlers.GetSettings().pipe(onPhone(person))
          expect(first.location).toEqual(LocationSharing.cases.Off.make({}))
          expect(yield* share.pipe(onPhone(person), Effect.flip)).toBeInstanceOf(LocationNotShared)
          expect(told(first.location, takenAt)).not.toContain('Where the person')

          // Turned on, it waits for a device; Vivid acting for the Person cannot send one itself.
          const on = yield* settingsHandlers
            .PatchSettings(new PatchSettingsRequest({ location: true }))
            .pipe(onPhone(person))
          expect(on.location).toEqual(LocationSharing.cases.Waiting.make({}))
          expect(yield* share.pipe(asVivid(person), Effect.flip)).toBeInstanceOf(Forbidden)

          // The phone's reading is kept, and Vivid reads it through Settings for this Person only.
          const shared = yield* share.pipe(onPhone(person))
          expect(shared.location).toEqual(LocationSharing.cases.Known.make({ reading: lekki }))
          const read = yield* settingsHandlers.GetSettings().pipe(asVivid(person))
          expect(read.location).toEqual(shared.location)
          const other = yield* settingsHandlers.GetSettings().pipe(onPhone(test.other.person))
          expect(other.location).toEqual(LocationSharing.cases.Off.make({}))

          const fresh = told(read.location, takenAt + 12 * MINUTE)
          expect(fresh).toContain('near Lekki, Lagos, Nigeria, 12 minutes ago')
          expect(fresh).toContain('accurate to about 1 km')
          expect(fresh).toContain('only when the answer depends on where they are now')
          expect(fresh).not.toContain(person.id)
          const old = told(read.location, takenAt + 5 * 60 * MINUTE)
          expect(old).toContain('5 hours ago')
          expect(old).toContain('That is old')

          // Turning it on again from another device keeps the reading already sent.
          const again = yield* settingsHandlers
            .PatchSettings(new PatchSettingsRequest({ location: true }))
            .pipe(onPhone(person))
          expect(again.location).toEqual(shared.location)

          // Turned off, the reading is forgotten in the same write and later readings are refused.
          const off = yield* settingsHandlers
            .PatchSettings(new PatchSettingsRequest({ location: false }))
            .pipe(onPhone(person))
          expect(off.location).toEqual(LocationSharing.cases.Off.make({}))
          expect(yield* share.pipe(onPhone(person), Effect.flip)).toBeInstanceOf(LocationNotShared)
          const after = yield* settingsHandlers.GetSettings().pipe(asVivid(person))
          expect(after.location).toEqual(LocationSharing.cases.Off.make({}))
          expect(told(after.location, takenAt + MINUTE)).not.toContain('Where the person')
        }).pipe(Effect.scoped),
    )
  })
})
