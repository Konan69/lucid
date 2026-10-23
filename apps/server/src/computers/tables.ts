import { sql } from 'drizzle-orm'
import { boolean, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type {
  BrowserAction,
  WindowAction,
  DeviceWork,
  DeviceAccess,
  DeviceId,
  DeviceRequestId,
  InstallationId,
  RunId,
  SessionId,
} from '@vivid/contracts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import type { DeviceReceipt, DeviceSubscriptionId } from './receipt.ts'

/**
 * One row per Person's Computer. A Person has at most one, and it is theirs in every workspace:
 * its files and its signed-in browser are personal, so it is never a Company's.
 *
 * `machine` is the provider's reference for the machine behind it. `status` is `starting`,
 * `running`, `stopped` or `failed`, changed at `since`; `reason` explains `failed`. `held` is true
 * while the Person has the keyboard and pointer, during which Vivid may not act on it.
 * `lastActivityAt` is epoch milliseconds for action/watch activity. Zero marks pre-policy rows
 * with no observation, so their first restored deadline is overdue rather than invented.
 */
export const computers = pgTable(
  'vivid_computers',
  {
    id: text('id').primaryKey(),
    personId: personColumn().notNull(),
    machine: text('machine').notNull(),
    status: text('status').notNull(),
    since: epoch('since').notNull(),
    lastActivityAt: epoch('last_activity_at').notNull().default(0),
    reason: text('reason'),
    held: boolean('held').notNull().default(false),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [uniqueIndex('vivid_computers_person').on(table.personId)],
)

/** A durable create intent precedes HTTP; its body and key survive crashes and config changes.
 * Provider identity is private server data. A lost binding never authorizes a replacement machine. */
export const machineBindings = pgTable('vivid_machine_bindings', {
  key: text('key').primaryKey(),
  intent: text('intent').notNull().unique(),
  requestedAt: epoch('requested_at').notNull(),
  request: jsonb('request').notNull(),
  providerId: text('provider_id').unique(),
  observedState: text('observed_state').notNull(),
  since: epoch('since').notNull(),
})

/**
 * One row per computer a Person's desktop app enrolled. It is the Person's own, in every
 * workspace, exactly like their Computer above: its browser is signed in as them.
 *
 * `installation_id` is what that desktop app calls itself; one installation is one Device for a
 * Person, which is what makes enrolling repeatable. `access` is the `DeviceAccess` tag (`Pending`,
 * `Allowed` or `Revoked`) and `access_since` the epoch milliseconds it began. The partial unique
 * index is the rule that a Person lets Vivid use one computer at a time: allowing a second one
 * without revoking the first cannot be written.
 *
 * The shape follows the reference desktop app's registration of a Person's own PC
 * (artifacts/night/reviews/chatgpt-latest.md, section 1, "Local PC used by the dot").
 */
export const devices = pgTable(
  'vivid_devices',
  {
    id: text('id').$type<DeviceId>().primaryKey(),
    personId: personColumn().notNull(),
    installationId: text('installation_id').$type<InstallationId>().notNull(),
    name: text('name').notNull(),
    access: text('access').$type<DeviceAccess['_tag']>().notNull(),
    accessSince: epoch('access_since').notNull(),
    enrolledAt: epoch('enrolled_at').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_devices_installation').on(table.personId, table.installationId),
    uniqueIndex('vivid_devices_allowed')
      .on(table.personId)
      .where(sql`${table.access} = 'Allowed'`),
  ],
)

/**
 * The ledger of what was sent to a Person's computer. A dispatch is never replayed, so the row
 * outlives the connection that carried it.
 *
 * It records that something happened, never what: the action's kind, not the text typed or the
 * address opened, and the receipt's tag, not the page that came back. Those are a Person's own
 * signed-in pages and possibly their passwords, and nothing here needs them.
 *
 * `receipt` is the encoded `DeviceReceipt`; `status` is its tag, computed by PostgreSQL from that
 * same value so the two cannot disagree. `thread_id` and `run_id` say which Run drove the
 * computer. Times are epoch milliseconds.
 */
export const deviceRequests = pgTable('vivid_device_requests', {
  id: text('id').$type<DeviceRequestId>().primaryKey(),
  deviceId: text('device_id')
    .$type<DeviceId>()
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  personId: personColumn().notNull(),
  sessionId: text('session_id').$type<SessionId>().notNull(),
  subscriptionId: text('subscription_id').$type<DeviceSubscriptionId>().notNull(),
  threadId: threadColumn('thread_id').notNull(),
  runId: text('run_id').$type<RunId>().notNull(),
  action: text('action')
    .$type<
      | BrowserAction['_tag']
      | WindowAction['_tag']
      | Extract<DeviceWork, { readonly browser: string }>['_tag']
    >()
    .notNull(),
  receipt: jsonb('receipt').$type<typeof DeviceReceipt.Encoded>().notNull(),
  status: text('status')
    .$type<DeviceReceipt['_tag']>()
    .generatedAlwaysAs(sql`("receipt"->>'_tag')`),
  dispatchedAt: epoch('dispatched_at').notNull(),
  expiresAt: epoch('expires_at').notNull(),
})
