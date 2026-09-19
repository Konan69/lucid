import { drizzle } from 'drizzle-orm/node-postgres'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { Pool, types } from 'pg'
import { bootstrapRuntimeSchema } from './migration.ts'

types.setTypeParser(20, (value) => Number(value))

const databaseUrl = Redacted.value(Effect.runSync(Config.Redacted('DATABASE_URL')))

export const pool = new Pool({ connectionString: databaseUrl })
export const db = drizzle({ client: pool })

/** Versioned application schema. Flue's own flue_* migration is separate in db.ts. */
export const schemaBootstrap = bootstrapRuntimeSchema(pool)

/** Promise adapter retained for the legacy Promise-based stores. */
export const schemaReady = Effect.runPromise(schemaBootstrap)
