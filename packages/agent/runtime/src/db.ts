// flue-blueprint: database/postgres@1
import { Config, Effect, Redacted } from 'effect'
import { Pool } from 'pg'
import { flueStorage } from './storage.ts'

// Flue imports this module as its database composition root before application services exist.
// oxlint-disable-next-line vivid/no-runpromise-in-library
const databaseUrl = Redacted.value(Effect.runSync(Config.Redacted('DATABASE_URL')))
const pool = new Pool({ connectionString: databaseUrl })

export default flueStorage(pool)
