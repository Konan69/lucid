import { jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { Channel, ChannelAddress, RunId } from '@vivid/contracts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'
import type { ChannelMessageId, ChannelEnrolmentId, ChannelPlace } from './provider.ts'

/** A code grants the account that messages it to one Person for ten minutes. */
export const channelCodes = pgTable(
  'vivid_channel_codes',
  {
    personId: personColumn().notNull(),
    channel: text('channel').$type<Channel>().notNull(),
    code: text('code').notNull(),
    expiresAt: epoch('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.channel] }),
    uniqueIndex('vivid_channel_codes_code').on(table.channel, table.code),
  ],
)

/** Personal ownership deliberately has no Company column: channel linking never grants shared reach. */
export const channelLinks = pgTable(
  'vivid_channel_links',
  {
    personId: personColumn().notNull(),
    channel: text('channel').$type<Channel>().notNull(),
    address: text('address').$type<ChannelAddress>().notNull(),
    textTo: text('text_to').$type<ChannelAddress>().notNull(),
    enrolmentId: text('enrolment_id').$type<ChannelEnrolmentId>().notNull(),
    since: epoch('since').notNull(),
    threadId: threadColumn('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.channel] }),
    uniqueIndex('vivid_channel_links_address').on(table.channel, table.address),
  ],
)

/**
 * Claim provider identity before interpreting content. Receipts outlive disconnect and Thread
 * deletion so replay stays harmless. No Person attribution, timestamps, addresses or words are kept.
 */
export const channelMessages = pgTable(
  'vivid_channel_messages',
  {
    channel: text('channel').$type<Channel>().notNull(),
    providerId: text('provider_id').$type<ChannelMessageId>().notNull(),
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
  since: epoch('since').notNull(),
  place: jsonb('place').$type<ChannelPlace>(),
  responseId: text('response_id').$type<RunId>().unique(),
  threadId: threadColumn('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['awaiting', 'unknown', 'sent', 'not-sent'] }).notNull(),
  updatedAt: epoch('updated_at').notNull(),
})
