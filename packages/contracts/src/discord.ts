import { Schema } from 'effect'
import { ServiceId } from './identity.js'

/**
 * Discord as Vivid's own Integration (`apps/server/src/discord`). A Person adds Vivid's bot to a
 * server they manage through Discord's "Add app" page, and each server is one Connection on this
 * service. Vivid reads and posts there through its own bot, never through the Person's account,
 * and nothing about Discord passes through Executor.
 */
export const DISCORD_SERVICE = ServiceId.make('vivid/discord')

/**
 * A Discord id (a snowflake): a server, a channel, a message or an account. Discord writes it as
 * a decimal string of at most twenty digits, and that string is what Vivid keeps and sends back.
 */
export const DiscordId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/u)).pipe(
  Schema.brand('DiscordId'),
)
export type DiscordId = typeof DiscordId.Type

/** A message's words as Discord takes them: its own limit is 2,000 characters. */
export const DiscordText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000))

const post = {
  server: DiscordId,
  channel: DiscordId,
  text: DiscordText,
  /** The message this one answers, in the same channel; null for a message of its own. */
  replyTo: Schema.NullOr(DiscordId),
}
const edit = { server: DiscordId, channel: DiscordId, message: DiscordId, text: DiscordText }

/**
 * What Vivid's bot writes in a connected server. Kept whole in an Approval, so the message the
 * Person allows is the one that is sent. Only the bot's own messages can be edited.
 */
export const DiscordWrite = Schema.TaggedUnion({ Post: post, Edit: edit })
export type DiscordWrite = typeof DiscordWrite.Type

/**
 * One thing Vivid asks of Discord. `Servers` lists the servers the acting Person has connected;
 * every other request names one of them, and the server refuses a server the Person has not
 * connected and a channel that is not in that server.
 */
export const DiscordAction = Schema.TaggedUnion({
  Servers: {},
  Channels: { server: DiscordId },
  Read: {
    server: DiscordId,
    channel: DiscordId,
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  },
  Post: post,
  Edit: edit,
})
export type DiscordAction = typeof DiscordAction.Type

/** A Discord tool call from a Run. Summary and rationale are what an Approval would say. */
export const UseDiscordRequest = Schema.Struct({
  action: DiscordAction,
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  rationale: Schema.String.check(Schema.isMaxLength(400)),
})
export interface UseDiscordRequest extends Schema.Schema.Type<typeof UseDiscordRequest> {}
