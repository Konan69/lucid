import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { Conflict, Settings, type PatchSettingsRequest, type PersonId } from '@vivid/contracts'
import {
  Database,
  type DatabaseInfrastructureError,
  type PersistedFields,
} from '../database/client.ts'
import { settingsTable } from './tables.ts'

type SettingsStoreError = DatabaseInfrastructureError | Conflict
const settingsDecoder = Schema.decodeUnknownEffect(Settings)

const decode = (value: PersistedFields) =>
  settingsDecoder(value).pipe(
    Effect.mapError(() => new Conflict({ message: 'Stored Settings data is invalid' })),
  )
export interface SettingsStoreService {
  readonly get: (personId: PersonId) => Effect.Effect<Settings, SettingsStoreError>
  readonly patch: (
    personId: PersonId,
    request: PatchSettingsRequest,
  ) => Effect.Effect<Settings, SettingsStoreError>
}
export class SettingsStore extends Context.Service<SettingsStore, SettingsStoreService>()(
  'vivid/SettingsStore',
) {}
export const settingsStoreLayer = Layer.effect(
  SettingsStore,
  Effect.gen(function* () {
    const database = yield* Database
    const get = Effect.fn('SettingsStore.get')(function* (personId: PersonId) {
      const rows = yield* database.run(
        database.select().from(settingsTable).where(eq(settingsTable.personId, personId)).limit(1),
      )
      const row = rows[0]
      if (row !== undefined) return yield* decode({ personId, theme: row.theme })
      yield* database.run(database.insert(settingsTable).values({ personId, theme: 'system' }))
      return yield* decode({ personId, theme: 'system' })
    })
    const patch = Effect.fn('SettingsStore.patch')(function* (
      personId: PersonId,
      request: PatchSettingsRequest,
    ) {
      const current = yield* get(personId)
      const theme = request.theme ?? current.theme
      const now = yield* Clock.currentTimeMillis
      const rows = yield* database.run(
        database
          .insert(settingsTable)
          .values({ personId, theme, updatedAt: new Date(now) })
          .onConflictDoUpdate({
            target: settingsTable.personId,
            set: { theme, updatedAt: new Date(now) },
          })
          .returning(),
      )
      const row = rows[0]
      if (row === undefined)
        return yield* Effect.fail(new Conflict({ message: 'Settings could not be saved' }))
      return yield* decode({ personId, theme: row.theme })
    })
    return SettingsStore.of({ get, patch })
  }),
)
