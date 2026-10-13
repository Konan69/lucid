import { eq, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  InvalidRequest,
  Settings,
  type PatchSettingsRequest,
  type PersonId,
} from '@vivid/contracts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { settingsTable } from './tables.ts'

type SettingsStoreError = DatabaseInfrastructureError | InvalidRequest

const decodeSettings = decodeStored(Settings, 'Settings')

export interface SettingsStoreService {
  /** A Person's settings, created with the defaults the first time they are asked for. */
  readonly get: (personId: PersonId) => Effect.Effect<Settings, DatabaseInfrastructureError>
  readonly patch: (
    personId: PersonId,
    request: PatchSettingsRequest,
  ) => Effect.Effect<Settings, SettingsStoreError>
}

export class SettingsStore extends Context.Service<SettingsStore, SettingsStoreService>()(
  'vivid/SettingsStore',
) {}

const toSettings = (row: typeof settingsTable.$inferSelect) =>
  decodeSettings({
    personId: row.personId,
    theme: row.theme,
    timezone: row.timezone,
    notify: row.notify,
    egress: row.egress,
  })

/**
 * Whether the platform knows a time zone by this name. Routines and "tomorrow at 9" are resolved
 * in it, so a name nothing can resolve is refused when it is set, not when a Routine comes due.
 */
const requireTimezone = (timezone: string) =>
  Effect.try({
    try: () => new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).resolvedOptions().timeZone,
    catch: () => new InvalidRequest({ message: 'That time zone is not one Vivid knows' }),
  })

const makeSettingsStore = Effect.fn('SettingsStore.make')(function* () {
  const database = yield* Database

  const get = Effect.fn('SettingsStore.get')(function* (personId: PersonId) {
    yield* database.run(
      database
        .insert(settingsTable)
        .values({ personId })
        .onConflictDoNothing({ target: settingsTable.personId }),
    )
    const rows = yield* database.run(
      database.select().from(settingsTable).where(eq(settingsTable.personId, personId)).limit(1),
    )
    return yield* toSettings(yield* returned(rows, 'Settings'))
  })

  const patch = Effect.fn('SettingsStore.patch')(function* (
    personId: PersonId,
    request: PatchSettingsRequest,
  ) {
    yield* get(personId)
    const timezone =
      request.timezone === undefined
        ? sql`${settingsTable.timezone}`
        : yield* requireTimezone(request.timezone)
    const now = yield* Clock.currentTimeMillis
    // Only the fields the caller named are written, so two devices changing different settings at
    // the same moment both keep their change.
    const rows = yield* database.run(
      database
        .update(settingsTable)
        .set({
          theme: request.theme === undefined ? sql`${settingsTable.theme}` : request.theme,
          notify: request.notify === undefined ? sql`${settingsTable.notify}` : request.notify,
          egress: request.egress === undefined ? sql`${settingsTable.egress}` : request.egress,
          timezone,
          updatedAt: new Date(now),
        })
        .where(eq(settingsTable.personId, personId))
        .returning(),
    )
    return yield* toSettings(yield* returned(rows, 'Settings'))
  })

  return SettingsStore.of({ get, patch })
})

export const settingsStoreLayer = Layer.effect(SettingsStore, makeSettingsStore())
