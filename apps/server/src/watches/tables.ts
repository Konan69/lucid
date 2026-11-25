import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { ConnectionId, WatchId, WatchStopReason } from '@vivid/contracts'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'
import { connections } from '../connections/tables.ts'

/**
 * One row per Watch: a Person's subscription to one event of one Integration's Executor app.
 *
 * `state` is the `WatchState` tag. `refresh_before` is the subscription's expiry while `Active`
 * and `stop_reason` says why a `Stopped` Watch stopped; the check keeps the three consistent.
 * `subscribed_name` (`<app slug>.<event>`), `arguments` and `callback_url` are exactly what was
 * sent to Executor: with Vivid's key they are the subscription's identity there, so renewal and
 * unsubscribe repeat them unchanged (executor@2.0.0-beta.23 `packages/sdk/src/implementation/
 * events.ts` `subscriptionId`). The signing secret is derived, never stored (`signature.ts`).
 * The required Connection survives removal as a tombstone, so stopped Watches keep their history.
 *
 * A name is unique among a Person's live Watches, because Vivid stops a Watch by its name.
 */
export const watches = pgTable(
  'vivid_watches',
  {
    id: text('id').$type<WatchId>().primaryKey(),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    name: text('name').notNull(),
    connectionId: text('connection_id')
      .$type<ConnectionId>()
      .notNull()
      .references(() => connections.id, { onDelete: 'no action' }),
    event: text('event').notNull(),
    subscribedName: text('subscribed_name').notNull(),
    arguments: jsonb('arguments').notNull(),
    instruction: text('instruction').notNull(),
    callbackUrl: text('callback_url').notNull(),
    state: text('state').$type<'Pending' | 'Active' | 'Stopped'>().notNull(),
    refreshBefore: epoch('refresh_before'),
    stopReason: text('stop_reason').$type<WatchStopReason>(),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_watches_live_name')
      .on(table.personId, table.name)
      .where(sql`${table.state} <> 'Stopped'`),
    index('vivid_watches_renewal').on(table.state, table.refreshBefore),
    index('vivid_watches_connection').on(table.connectionId),
    check(
      'vivid_watches_state',
      sql`(${table.state} = 'Pending' and ${table.refreshBefore} is null and ${table.stopReason} is null)
        or (${table.state} = 'Active' and ${table.refreshBefore} is not null and ${table.stopReason} is null)
        or (${table.state} = 'Stopped' and ${table.stopReason} is not null)`,
    ),
  ],
)
