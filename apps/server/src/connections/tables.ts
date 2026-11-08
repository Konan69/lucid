import { bigint, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/**
 * One row per Connection: an authorized relationship with an external account.
 *
 * A row with no `company_id` is its `person_id`'s own and only ever acts for them. A row with a
 * `company_id` is shared: an admin added it and every Member's Vivid may use it. `references` is
 * the encoded set of identifiers the Connection layer needs to find the account again; no
 * credential is ever stored here or anywhere in this database. `status` is `ready`,
 * `needs-authorization` or `failed`, and `reason` explains `failed`.
 *
 * One Person may hold several rows for one `service`: each is one more account, and nothing here
 * makes a service unique. Two columns tell such rows apart and are never mixed. `name` is what the
 * Person called the account ("Work"), null until they call it anything. `identity` is who the
 * service says signed in ("ada@example.com"), null when the service does not say.
 *
 * `label` is retired: no code reads it. There was one `label` for both facts, and every client
 * filled it with the service's own name, so it told no two accounts apart. The column stays for
 * one release, and a new row is still written with the service's name in it, exactly what every
 * client used to send: a deploy applies migrations while the previous server is still answering,
 * and that server selects `label`, inserts it, and refuses a row in which it is null. So the
 * previous release keeps working beside this one and after a roll back. Drop the column, and the
 * line that writes it (`begin` in `store.ts`), in the release after this one (6 October 2026).
 */
export const connections = pgTable(
  'vivid_connections',
  {
    id: text('id').primaryKey(),
    service: text('service').notNull(),
    serviceName: text('service_name').notNull(),
    name: text('name'),
    identity: text('identity'),
    label: text('label'),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    references: jsonb('references').notNull(),
    // Null only until a legacy selection is reconciled or while reconnection is required.
    executorApp: text('executor_app'),
    status: text('status').notNull(),
    // Existing trips returned to the web; each new client trip writes its own surface.
    returnsTo: text('returns_to').notNull().default('Web'),
    reason: text('reason'),
    // Raised by every write that changes the authorization (a sign-in, a lost sign-in, a failure,
    // a migration of its references), so an Approval bound to the account as it was signed in can
    // tell it is no longer that account. `updated_at` is a clock reading, which can repeat or step
    // back; this only rises.
    authorizationGeneration: integer('authorization_generation').notNull().default(0),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_connections_executor_app').on(table.executorApp),
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
