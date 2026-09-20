import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core'

/** Preserves the connector package's persisted names so existing grants survive the move. */
export const credentials = pgTable(
  'vivid_credentials',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id').notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    scope: text('scope').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('vivid_credentials_connector').on(table.connectorId)],
)
