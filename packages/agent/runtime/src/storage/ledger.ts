/**
 * Where the runtime's migration ledger lives: drizzle's table, in a schema of the runtime's own,
 * apart from the server's ledger (`drizzle.__drizzle_migrations`). `drizzle.config.ts` writes it
 * and `stores.ts` (`checkMigrated`) reads it.
 */
export const LEDGER = { schema: 'runtime_migrations', table: '__drizzle_migrations' } as const
