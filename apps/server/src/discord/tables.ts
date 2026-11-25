import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { ConnectionId, DiscordId, SignInSurface } from '@vivid/contracts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/**
 * One Discord server a Person added Vivid's bot to: one Connection on `DISCORD_SERVICE`. It is
 * personal, like a Text Vivid link, and never shared with a Company.
 *
 * `userId` is the Person's own Discord account, read once from Discord when they added the bot;
 * a mention of the bot in this server is theirs only when it comes from that account, so one
 * account in one server belongs to one Person. `threadId` is the private Thread those mentions
 * are answered in, set by the first one. Deleting the row is disconnecting the server.
 */
export const discordServers = pgTable(
  'vivid_discord_servers',
  {
    id: text('id').$type<ConnectionId>().primaryKey(),
    personId: personColumn().notNull(),
    guildId: text('guild_id').$type<DiscordId>().notNull(),
    guildName: text('guild_name').notNull(),
    userId: text('user_id').$type<DiscordId>().notNull(),
    threadId: threadColumn('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    addedAt: epoch('added_at').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_discord_servers_person').on(table.personId, table.guildId),
    uniqueIndex('vivid_discord_servers_member').on(table.guildId, table.userId),
  ],
)

/**
 * A trip to Discord's "Add app" page that has not come back. Only a digest of the state the
 * browser carries is kept, so the row proves the return without holding anything that would
 * complete it. Discord's return consumes the row once; `id` becomes the Connection's id, so the
 * screen that began the trip sees the very account it is waiting for arrive.
 */
export const discordInstalls = pgTable('vivid_discord_installs', {
  id: text('id').$type<ConnectionId>().primaryKey(),
  personId: personColumn().notNull(),
  stateHash: text('state_hash').notNull().unique(),
  returnsTo: text('returns_to').$type<SignInSurface>().notNull(),
  expiresAt: epoch('expires_at').notNull(),
})
