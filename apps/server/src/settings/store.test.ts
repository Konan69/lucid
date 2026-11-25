import { describe, expect, layer } from '@effect/vitest'
import { Appearance, InvalidRequest, Look } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { fixture } from '../approvals/testing.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { SettingsStore, settingsStoreLayer } from './store.ts'

const testLayer = settingsStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))
const appearance = new Appearance({
  name: 'Juno',
  look: Look.cases.Hue.make({ hue: 'cyan' }),
  outline: 'hexagon',
})

describe.skipIf(!testDatabaseConfigured)('Settings persistence', () => {
  layer(testLayer)((it) => {
    it.effect('appearance changes preserve personal preferences and later patches', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* SettingsStore
        const personId = test.personal.person.id
        expect(yield* store.get(personId)).toMatchObject({
          theme: 'system',
          timezone: 'UTC',
          egress: false,
        })
        const preferences = yield* store.patch(personId, {
          theme: 'dark',
          timezone: 'Africa/Lagos',
          egress: true,
        })
        expect(yield* store.setAppearance(personId, appearance)).toEqual(appearance)
        expect(yield* store.get(personId)).toEqual(preferences)
        expect(yield* store.patch(personId, { theme: 'light' })).toMatchObject({
          theme: 'light',
          timezone: 'Africa/Lagos',
          egress: true,
        })
        expect(
          yield* store.patch(personId, { timezone: 'Invalid/Zone' }).pipe(Effect.flip),
        ).toBeInstanceOf(InvalidRequest)
        expect((yield* store.get(personId)).timezone).toBe('Africa/Lagos')
      }).pipe(Effect.scoped),
    )
  })
})
