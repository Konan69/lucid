import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { types, Pool } from 'pg'

types.setTypeParser(20, (value) => Number(value))

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle({ client: pool })

/** Versioned application schema. Flue's own flue_* migration is separate in db.ts. */
export const schemaReady = (async () => {
  const existing = await db.execute(sql`SELECT to_regclass('public.vivid_conversations') AS name`)
  if (!existing.rows[0]?.name) {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    })
  }

  await db.transaction(async (tx) => {
    // Serialize first-boot migrations when tests or multiple processes start together.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(741936218)`)
    const latest = await tx.execute(sql`
      SELECT version FROM vivid_schema_migrations ORDER BY version DESC LIMIT 1
    `)
    const version = latest.rows[0] ? Number(latest.rows[0].version) : 0

    // These ALTERs preserve compatibility with databases created by the pre-Drizzle runtime.
    if (version < 2) {
      await tx.execute(
        sql`ALTER TABLE vivid_conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`,
      )
      await tx.execute(
        sql`ALTER TABLE vivid_follow_ups ADD COLUMN IF NOT EXISTS submission_id TEXT`,
      )
      await tx.execute(
        sql`ALTER TABLE vivid_routines ADD COLUMN IF NOT EXISTS next_expected_at BIGINT`,
      )
      await tx.execute(
        sql`ALTER TABLE vivid_routines ADD COLUMN IF NOT EXISTS last_missed_at BIGINT`,
      )
      await tx.execute(
        sql`ALTER TABLE vivid_routines ADD COLUMN IF NOT EXISTS library_folder_id TEXT`,
      )
      await tx.execute(
        sql`ALTER TABLE vivid_library_documents ADD COLUMN IF NOT EXISTS folder_id TEXT`,
      )
      await tx.execute(
        sql`ALTER TABLE vivid_library_chunks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED`,
      )
      await tx.execute(
        sql`CREATE INDEX IF NOT EXISTS vivid_library_documents_folder ON vivid_library_documents(folder_id, created_at DESC)`,
      )
      await tx.execute(
        sql`CREATE INDEX IF NOT EXISTS vivid_library_chunks_search ON vivid_library_chunks USING GIN(search_vector)`,
      )
      await tx.execute(
        sql`INSERT INTO vivid_schema_migrations(version, applied_at) VALUES (2, ${Date.now()}) ON CONFLICT (version) DO NOTHING`,
      )
    }
  })
})()
