import { bigint, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/**
 * One row per Connection: an authorized relationship with an external account.
 *
 * A row with no `company_id` is its `person_id`'s own and only ever acts for them. A row with a
 * `company_id` is shared: an admin added it and every Member's Vivid may use it. `references` is
 * the encoded set of identifiers the Connection layer needs to find the account again; no
 * credential is ever stored here or anywhere in this database. `status` is `ready`,
 * `needs-authorization` or `failed`, and `reason` explains `failed`.
 */
export const connections = pgTable(
  'vivid_connections',
  {
    id: text('id').primaryKey(),
    service: text('service').notNull(),
    serviceName: text('service_name').notNull(),
    label: text('label').notNull(),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    references: jsonb('references').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    index('vivid_connections_person').on(table.personId),
    index('vivid_connections_company').on(table.companyId),
  ],
)

/**
 * Retired. The grants the first Google connector stored, kept only so that migrating does not
 * delete data nobody asked to delete; no code reads or writes it. Dropping it is a decision for
 * whoever owns the installation.
 */
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
