import { jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { Channel, ChannelAddress, RunId, PersonId } from '@vivid/contracts'
import { personTable } from '../auth/tables.ts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'
import type { LinkState } from './model.ts'
import type { ChannelMessageId } from './provider.ts'

/** Personal ownership deliberately has no Company column: channel linking never grants shared reach. */
export const channelLinks = pgTable(
  'vivid_channel_links',
  {
    personId: personColumn().notNull(),
    channel: text('channel').$type<Channel>().notNull(),
    address: text('address').$type<ChannelAddress>().notNull(),
    textTo: text('text_to').$type<ChannelAddress>().notNull(),
    enrolmentId: text('enrolment_id').notNull(),
    state: jsonb('state').$type<LinkState>().notNull(),
    threadId: threadColumn('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.channel] }),
    uniqueIndex('vivid_channel_links_address').on(table.channel, table.address),
  ],
)

/**
 * Claim before interpreting content. Ownership is genuinely absent for an unlinked sender;
 * linked claims retain their Person. No words or raw unlinked address ever enter this ledger.
 * Provider identity survives disconnect and Thread deletion so reconnect replay stays harmless.
 */
export const channelMessages = pgTable(
  'vivid_channel_messages',
  {
    channel: text('channel').$type<Channel>().notNull(),
    providerId: text('provider_id').$type<ChannelMessageId>().notNull(),
    personId: text('person_id')
      .$type<PersonId>()
      .references(() => personTable.id, { onDelete: 'set null' }),
    receivedAt: epoch('received_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.channel, table.providerId] })],
)

/**
 * Run routing is recorded before admission. A send claim changes awaiting to unknown before
 * external I/O; a crash never resends it because duplicate texts are worse than a missing reply.
 * This table owns delivery evidence only; message content belongs exclusively to the Thread.
 */
export const channelReplies = pgTable('vivid_channel_replies', {
  runId: text('run_id').$type<RunId>().primaryKey(),
  personId: personColumn().notNull(),
  channel: text('channel').$type<Channel>().notNull(),
  address: text('address').$type<ChannelAddress>().notNull(),
  threadId: threadColumn('thread_id').notNull(),
  status: text('status', { enum: ['awaiting', 'unknown', 'sent'] }).notNull(),
  updatedAt: epoch('updated_at').notNull(),
})

/**
 * This is the one wholly ownerless table: an unlinked sender has no Person. It is channel
 * infrastructure, keyed by an address hash and UTC day, solely to bound the onboarding reply.
 */
export const channelNotices = pgTable(
  'vivid_channel_notices',
  {
    channel: text('channel').$type<Channel>().notNull(),
    addressHash: text('address_hash').notNull(),
    day: text('day').notNull(),
  },
  (table) => [primaryKey({ columns: [table.channel, table.addressHash, table.day] })],
)
