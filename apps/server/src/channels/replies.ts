import { RunId, ThreadAudience, ThreadId } from '@vivid/contracts'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import { Database } from '../database/client.ts'
import { Settlement } from '../runtime/client.ts'
import { ThreadStore } from '../threads/store.ts'
import { ChannelLedger } from './ledger.ts'
import { ChannelProvider } from './provider.ts'
import { ChannelStore, channelActor } from './store.ts'
import { ChannelTextLimit, channelText, splitChannelText } from './text.ts'

/** Final text remains runtime-owned; the channel ledger retains only routing and delivery evidence. */
export const ChannelEnding = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  settlement: Settlement,
})
export type ChannelEnding = typeof ChannelEnding.Type

/** Vivid's conservative chunk budget; Spectrum declares no text-size limit. */
const replyLimit = ChannelTextLimit.make(4000)

/** Replies depend only on linking and Thread ownership, so startup can resume Runs without a queue. */
const makeReplies = Effect.fn('Channels.makeReplies')(function* () {
  const database = yield* Database
  const ledger = yield* ChannelLedger
  const provider = yield* ChannelProvider
  const links = yield* ChannelStore
  const threads = yield* ThreadStore

  /**
   * Claim before external I/O. A crash or failed send leaves unknown and is never retried because
   * Spectrum Space.send cannot deduplicate caller keys. App Runs have no route and send nothing.
   * Recheck personal ownership so a disconnected number or shared/deleted Thread receives nothing.
   */
  const ended = Effect.fn('Channels.replyEnded')(function* (event: ChannelEnding) {
    const claimed = yield* ledger.claim(event.runId)
    if (Option.isNone(claimed)) return
    const route = claimed.value
    const link = yield* links.byPerson(route.personId, route.channel)
    if (
      Option.isNone(link) ||
      link.value.address !== route.address ||
      link.value.threadId !== route.threadId ||
      event.threadId !== route.threadId
    )
      return
    const actor = yield* channelActor(route.personId).pipe(
      Effect.provideService(Database, database),
    )
    const personal = (yield* threads.list(actor)).some(
      (thread) => thread.id === route.threadId && ThreadAudience.guards.Private(thread.audience),
    )
    if (!personal) return
    if (Settlement.guards.Completed(event.settlement)) {
      const parts = splitChannelText(channelText(event.settlement.reply), replyLimit)
      yield* Effect.forEach(
        parts,
        (text) =>
          provider.send({ channel: route.channel, address: route.address, text, key: route.runId }),
        { discard: true },
      )
    }
    yield* ledger.sent(event.runId)
  })
  return { ended }
})

export class ChannelReplies extends Context.Service<
  ChannelReplies,
  Effect.Success<ReturnType<typeof makeReplies>>
>()('vivid/ChannelReplies') {}
export const channelRepliesLayer = Layer.effect(ChannelReplies, makeReplies())

/** Isolated Conversation suites explicitly have no channel routes or external reply transport. */
export const silentChannelRepliesLayer = Layer.succeed(ChannelReplies, {
  ended: Effect.fn('Channels.silentReply')(() => Effect.void),
})
