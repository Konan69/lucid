import * as NodeURL from 'node:url'
import { LEDGER } from './src/storage/ledger.ts'

/**
 * The runtime's migration owner: its tables (`src/storage/tables.ts`), their generated SQL
 * (`./drizzle`) and a ledger of its own (`runtime_migrations.__drizzle_migrations`), so the
 * runtime's migrations share nothing with the server's, not even the ledger the server's two
 * owners use. The runtime service runs this owner in its own pre-deploy step (`db:migrate`,
 * `infra/railway.ts`); root `pnpm db:migrate` (`scripts/migrate.mjs`) runs it after the server's
 * owners. The runtime process never migrates; it refuses to start until this owner's newest
 * migration is in the ledger (`src/storage/stores.ts`, `checkMigrated`).
 *
 * Paths are named from this file's own location, so the config works from any directory.
 */
const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for runtime migrations')

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url))

export default {
  dialect: 'postgresql',
  schema: here('./src/storage/tables.ts'),
  out: here('./drizzle'),
  migrations: { schema: LEDGER.schema, table: LEDGER.table },
  dbCredentials: { url: databaseUrl },
}
