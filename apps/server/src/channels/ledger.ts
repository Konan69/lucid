import { and, eq } from 'drizzle-orm'
import { Channel, ChannelAddress, PersonId, RunId, ThreadId } from '@vivid/contracts'
import { Clock, Context, Effect, Layer, Option, Schema } from 'effect'
import { Database, decodeStored } from '../database/client.ts'
import { type ChannelInbound } from './provider.ts'
import { channelMessages, channelReplies } from './tables.ts'

const Route = Schema.Struct({
  runId: RunId,
  personId: PersonId,
  channel: Channel,
  address: ChannelAddress,
  threadId: ThreadId,
})
export type ChannelRoute = typeof Route.Type
const decodeRoute = decodeStored(Route, 'channel reply route')

/** SQL uniqueness is the authority across processes; no process-local deduplication can survive a replay. */
const makeLedger = Effect.fn('Channels.makeLedger')(function* () {
  const database = yield* Database

  /** Commit the provider id before inspecting words, ownership, or starting any Run. */
  const receive = Effect.fn('Channels.receive')(function* (message: ChannelInbound) {
    const rows = yield* database.run(
      database
        .insert(channelMessages)
        .values({
          channel: message.channel,
          providerId: message.id,
          receivedAt: message.receivedAt,
        })
        .onConflictDoNothing()
        .returning({ id: channelMessages.providerId }),
    )
    return rows.length > 0
  })

  /** Attribute only known senders; a later deleted Person leaves the replay receipt intact. */
  const attribute = Effect.fn('Channels.attribute')(function* (
    message: ChannelInbound,
    personId: PersonId,
  ) {
    yield* database.run(
      database
        .update(channelMessages)
        .set({ personId })
        .where(
          and(
            eq(channelMessages.channel, message.channel),
            eq(channelMessages.providerId, message.id),
          ),
        ),
    )
  })

  /** Route before Conversation.deliver: a fast Run can settle before admission returns its receipt. */
  const route = Effect.fn('Channels.routeRun')(function* (input: ChannelRoute) {
    yield* database.run(
      database
        .insert(channelReplies)
        .values({
          runId: input.runId,
          personId: input.personId,
          channel: input.channel,
          address: input.address,
          threadId: input.threadId,
          status: 'awaiting',
          updatedAt: yield* Clock.currentTimeMillis,
        })
        .onConflictDoNothing(),
    )
  })

  /**
   * Claim the whole reply before its first part leaves. Even a crash between claim and send is
   * unknown and never retried: Spectrum 12.10.1 Space.send cannot deduplicate a caller's key.
   * PersistedQueue retries and Workflow activities would resend that uncertain external effect;
   * neither fits this deliberately at-most-once delivery policy (rc.116 persistence source).
   */
  const claim = Effect.fn('Channels.claimReply')(function* (runId: RunId) {
    const rows = yield* database.run(
      database
        .update(channelReplies)
        .set({ status: 'unknown', updatedAt: yield* Clock.currentTimeMillis })
        .where(and(eq(channelReplies.runId, runId), eq(channelReplies.status, 'awaiting')))
        .returning(),
    )
    return rows[0] === undefined
      ? Option.none<ChannelRoute>()
      : Option.some(yield* decodeRoute(rows[0]))
  })

  /** Receipt after every part succeeded; any failure leaves unknown evidence and no resend path. */
  const sent = Effect.fn('Channels.replySent')(function* (runId: RunId) {
    yield* database.run(
      database
        .update(channelReplies)
        .set({ status: 'sent', updatedAt: yield* Clock.currentTimeMillis })
        .where(eq(channelReplies.runId, runId)),
    )
  })
  return { receive, attribute, route, claim, sent }
})

export class ChannelLedger extends Context.Service<
  ChannelLedger,
  Effect.Success<ReturnType<typeof makeLedger>>
>()('vivid/ChannelLedger') {}
export const channelLedgerLayer = Layer.effect(ChannelLedger, makeLedger())
