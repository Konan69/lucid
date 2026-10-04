import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Appearance, Workspace, type CompanyId, type PersonId } from '@vivid/contracts'
// The appearance has no table of its own: a Person has exactly one and so does a Company, so it
// is two columns on the row that already is that Person's settings and that Company. Those two
// tables are read here for these columns alone; every other rule about them stays in their stores.
import { companyTable } from '../companies/tables.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { SettingsStore } from '../settings/store.ts'
import { settingsTable } from '../settings/tables.ts'
import { announce, Topic } from '../live/changes.ts'

/** The database callback is the sole authority for writing and announcing on one connection. */
type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

/**
 * Whose Vivid is being asked about: the Person's own in their personal space, or the one a
 * Company shares. The workspace decides it and nothing else does, so the store takes the
 * workspace's answer as a value and has no rule of its own about who may write.
 */
export type AppearanceOwner = Data.TaggedEnum<{
  Person: { readonly personId: PersonId }
  Company: { readonly companyId: CompanyId }
}>
export const AppearanceOwner = Data.taggedEnum<AppearanceOwner>()

/** The owner of Vivid's appearance where this Person is working. */
export const appearanceOwnerOf = (personId: PersonId, workspace: Workspace): AppearanceOwner =>
  Workspace.match(workspace, {
    Personal: (): AppearanceOwner => AppearanceOwner.Person({ personId }),
    Company: ({ company }): AppearanceOwner => AppearanceOwner.Company({ companyId: company.id }),
  })

export interface AppearanceStoreService {
  readonly get: (owner: AppearanceOwner) => Effect.Effect<Appearance, DatabaseInfrastructureError>
  /** Replaces the whole appearance. The name and the look are chosen together and saved together. */
  readonly set: (
    owner: AppearanceOwner,
    appearance: Appearance,
  ) => Effect.Effect<Appearance, DatabaseInfrastructureError>
}

export class AppearanceStore extends Context.Service<AppearanceStore, AppearanceStoreService>()(
  'vivid/AppearanceStore',
) {}

// The look is a JSON column and the name a text one an older version may have written under a
// looser rule, so both are decoded on every read like any other stored record.
const decodeAppearance = decodeStored(Appearance, 'Appearance')

const stored = (row: {
  readonly vividName: string
  readonly vividLook: unknown
  readonly vividOutline: string
}) => decodeAppearance({ name: row.vividName, look: row.vividLook, outline: row.vividOutline })

const columns = (table: typeof settingsTable | typeof companyTable) => ({
  vividName: table.vividName,
  vividLook: table.vividLook,
  vividOutline: table.vividOutline,
})

/** An appearance belongs to its stored owner; a Company write never moves the writer's Person. */
const appearanceTopics = (owner: AppearanceOwner): ReadonlyArray<Topic> =>
  AppearanceOwner.$match(owner, {
    Person: ({ personId }) => [Topic.person(personId)],
    Company: ({ companyId }) => [Topic.company(companyId)],
  })

const makeAppearanceStore = Effect.fn('AppearanceStore.make')(function* () {
  const database = yield* Database
  const settings = yield* SettingsStore

  const ofPerson = Effect.fn('AppearanceStore.ofPerson')(function* (personId: PersonId) {
    // A Person's settings row is made the first time it is asked for; asking through the Settings
    // store keeps that one rule in one place and guarantees the row read below exists.
    yield* settings.get(personId)
    const rows = yield* database.run(
      database
        .select(columns(settingsTable))
        .from(settingsTable)
        .where(eq(settingsTable.personId, personId))
        .limit(1),
    )
    return yield* stored(yield* returned(rows, 'Appearance'))
  })

  const ofCompany = Effect.fn('AppearanceStore.ofCompany')(function* (companyId: CompanyId) {
    const rows = yield* database.run(
      database
        .select(columns(companyTable))
        .from(companyTable)
        .where(eq(companyTable.id, companyId))
        .limit(1),
    )
    return yield* stored(yield* returned(rows, 'Appearance'))
  })

  const get = Effect.fn('AppearanceStore.get')(function* (owner: AppearanceOwner) {
    return yield* AppearanceOwner.$match(owner, {
      Person: ({ personId }) => ofPerson(personId),
      Company: ({ companyId }) => ofCompany(companyId),
    })
  })

  /** SettingsStore remains the single lazy-row creator; its statements join this transaction. */
  const setPerson = Effect.fn('AppearanceStore.setPerson')(function* (
    tx: Transaction,
    personId: PersonId,
    appearance: Appearance,
    now: number,
  ) {
    yield* settings.get(personId)
    return yield* tx
      .update(settingsTable)
      .set({
        vividName: appearance.name,
        vividLook: appearance.look,
        vividOutline: appearance.outline,
        updatedAt: new Date(now),
      })
      .where(eq(settingsTable.personId, personId))
      .returning(columns(settingsTable))
  })

  /** The Company's appearance columns are replaced together; unrelated Company data is untouched. */
  const setCompany = Effect.fn('AppearanceStore.setCompany')(function* (
    tx: Transaction,
    companyId: CompanyId,
    appearance: Appearance,
  ) {
    return yield* tx
      .update(companyTable)
      .set({
        vividName: appearance.name,
        vividLook: appearance.look,
        vividOutline: appearance.outline,
      })
      .where(eq(companyTable.id, companyId))
      .returning(columns(companyTable))
  })

  /** Decode before announcing so invalid stored values fail the same writing unit. */
  const replace = Effect.fn('AppearanceStore.replace')(function* (
    tx: Transaction,
    owner: AppearanceOwner,
    appearance: Appearance,
    now: number,
  ) {
    const rows = yield* AppearanceOwner.$match(owner, {
      Person: ({ personId }) => setPerson(tx, personId, appearance, now),
      Company: ({ companyId }) => setCompany(tx, companyId, appearance),
    })
    const saved = yield* stored(yield* returned(rows, 'Appearance'))
    yield* announce(tx, appearanceTopics(owner))
    return saved
  })

  /**
   * Lazy Settings creation, the decoded appearance and its owner's notice commit as one unit.
   * live/changes.ts announce uses the writing connection. Drizzle's EffectPgSession.transaction
   * (effect-postgres/session.js) and rc.116 SqlClient.ts make select the fiber's transaction
   * connection, so SettingsStore.get's root-database insert and select join it too.
   */
  const set = Effect.fn('AppearanceStore.set')(function* (
    owner: AppearanceOwner,
    appearance: Appearance,
  ) {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) => replace(tx, owner, appearance, now))
  })

  return AppearanceStore.of({ get, set })
})

export const appearanceStoreLayer = Layer.effect(AppearanceStore, makeAppearanceStore())
