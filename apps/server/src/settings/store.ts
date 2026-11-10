import { and, eq, sql } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  Appearance,
  InvalidRequest,
  LocationNotShared,
  LocationSharing,
  Settings,
  WakingHours,
  type LocationReading,
  type PatchSettingsRequest,
  type PersonId,
} from '@vivid/contracts'
import {
  Database,
  decodeStored,
  encodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { settingsTable } from './tables.ts'

type SettingsStoreError = DatabaseInfrastructureError | InvalidRequest

const decodeSettings = decodeStored(Settings, 'Settings')
const decodeAppearance = decodeStored(Appearance, 'Appearance')
const encodeHours = encodeStored(WakingHours, 'wakingHours')
const encodeSharing = encodeStored(LocationSharing, 'location')

export interface SettingsStoreService {
  /** A Person's settings, created with the defaults the first time they are asked for. */
  readonly get: (personId: PersonId) => Effect.Effect<Settings, DatabaseInfrastructureError>
  /** Replaces the personal appearance inside the caller's transaction, including lazy Settings creation. */
  readonly setAppearance: (
    personId: PersonId,
    appearance: Appearance,
  ) => Effect.Effect<Appearance, DatabaseInfrastructureError>
  readonly setWakingHours: (
    personId: PersonId,
    hours: WakingHours,
  ) => Effect.Effect<Settings, DatabaseInfrastructureError>
  readonly patch: (
    personId: PersonId,
    request: PatchSettingsRequest,
  ) => Effect.Effect<Settings, SettingsStoreError>
  /** Keeps a device's reading as the Person's latest, only while they share their location. */
  readonly shareLocation: (
    personId: PersonId,
    reading: LocationReading,
  ) => Effect.Effect<Settings, DatabaseInfrastructureError | LocationNotShared>
}

export class SettingsStore extends Context.Service<SettingsStore, SettingsStoreService>()(
  'vivid/SettingsStore',
) {}

const toSettings = (row: typeof settingsTable.$inferSelect) =>
  decodeSettings({
    personId: row.personId,
    theme: row.theme,
    timezone: row.timezone,
    wakingHours: row.wakingHours,
    egress: row.egress,
    location: row.location,
  })

/** Whether the stored `LocationSharing` is `Off`, read in SQL so the check and the write are one. */
const sharingOff = sql`${settingsTable.location}->>'_tag' = 'Off'`

/**
 * Whether the platform knows a time zone by this name. Local dates and times are resolved
 * in it, so a name nothing can resolve is refused when it is set, before interpreting a date.
 */
const requireTimezone = (timezone: string) =>
  Effect.try({
    try: () => new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).resolvedOptions().timeZone,
    catch: () => new InvalidRequest({ message: 'That time zone is not one Vivid knows' }),
  })

/**
 * What turning location sharing on or off writes. Off forgets the reading in the same write.
 * On keeps a reading another device already sent, so pressing it again loses nothing; from
 * `Off` it waits for the first one.
 */
const locationChange = Effect.fn('SettingsStore.locationChange')(function* (sharing: boolean) {
  if (!sharing) return yield* encodeSharing(LocationSharing.cases.Off.make({}))
  const waiting = yield* encodeSharing(LocationSharing.cases.Waiting.make({}))
  return sql`case when ${sharingOff} then ${JSON.stringify(waiting)}::jsonb else ${settingsTable.location} end`
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
    const location =
      request.location === undefined
        ? sql`${settingsTable.location}`
        : yield* locationChange(request.location)
    const now = yield* Clock.currentTimeMillis
    // Only the fields the caller named are written, so two devices changing different settings at
    // the same moment both keep their change.
    const rows = yield* database.run(
      database
        .update(settingsTable)
        .set({
          theme: request.theme === undefined ? sql`${settingsTable.theme}` : request.theme,
          egress: request.egress === undefined ? sql`${settingsTable.egress}` : request.egress,
          location,
          timezone,
          updatedAt: new Date(now),
        })
        .where(eq(settingsTable.personId, personId))
        .returning(),
    )
    return yield* toSettings(yield* returned(rows, 'Settings'))
  })

  /**
   * The reading replaces the last only while sharing is on, decided by the same statement that
   * writes it: a phone that read its place a moment before sharing was turned off on another
   * device is refused rather than storing a place the Person asked Vivid to forget.
   */
  const shareLocation = Effect.fn('SettingsStore.shareLocation')(function* (
    personId: PersonId,
    reading: LocationReading,
  ) {
    yield* get(personId)
    const known = yield* encodeSharing(LocationSharing.cases.Known.make({ reading }))
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(settingsTable)
        .set({ location: known, updatedAt: new Date(now) })
        .where(and(eq(settingsTable.personId, personId), sql`not (${sharingOff})`))
        .returning(),
    )
    const [row] = rows
    if (row === undefined) return yield* new LocationNotShared({})
    return yield* toSettings(row)
  })

  /** The ambient SQL transaction includes lazy creation, decoding, and the caller's notice. */
  const setAppearance = Effect.fn('SettingsStore.setAppearance')(function* (
    personId: PersonId,
    appearance: Appearance,
  ) {
    const now = yield* Clock.currentTimeMillis
    yield* get(personId)
    const rows = yield* database.run(
      database
        .update(settingsTable)
        .set({
          vividName: appearance.name,
          vividLook: appearance.look,
          vividOutline: appearance.outline,
          updatedAt: new Date(now),
        })
        .where(eq(settingsTable.personId, personId))
        .returning({
          name: settingsTable.vividName,
          look: settingsTable.vividLook,
          outline: settingsTable.vividOutline,
        }),
    )
    return yield* decodeAppearance(yield* returned(rows, 'Appearance'))
  })

  /** Only the contact window changes; other Settings writes keep it intact. */
  const setWakingHours = Effect.fn('SettingsStore.setWakingHours')(function* (
    personId: PersonId,
    hours: WakingHours,
  ) {
    yield* get(personId)
    const wakingHours = yield* encodeHours(hours)
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(settingsTable)
        .set({ wakingHours, updatedAt: new Date(now) })
        .where(eq(settingsTable.personId, personId))
        .returning(),
    )
    return yield* toSettings(yield* returned(rows, 'Settings'))
  })

  return SettingsStore.of({ get, patch, setAppearance, shareLocation, setWakingHours })
})

export const settingsStoreLayer = Layer.effect(SettingsStore, makeSettingsStore())
