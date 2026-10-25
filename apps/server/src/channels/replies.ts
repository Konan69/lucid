import type { ResponseId } from '../runtime/settlement.ts'
import { ChannelAddress, RunId, ThreadAudience, ThreadId } from '@vivid/contracts'
import { Context, Effect, Layer, Option, Predicate, Schema } from 'effect'
import { Database } from '../database/client.ts'
import { Settlement } from '../runtime/client.ts'
import { ThreadStore } from '../threads/store.ts'
import { findThread } from '../threads/access.ts'
import { ChannelLedger, type ChannelRoute } from './ledger.ts'
import { ChannelProvider, ChannelSendTimedOut } from './provider.ts'
import { ChannelStore } from './store.ts'
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

/** Bounds one provider send acceptance, so every completed chunk renews reply progress.
 * Source: unmeasured. Spectrum exposes no send-progress/cancellation signal; expiry preserves
 * unknown delivery and never replays a partially dispatched reply. */
const CHUNK_ACCEPTANCE_LIMIT = '30 seconds'

/** Replies recheck the current link and personal Thread before any external I/O. */
const makeReplies = Effect.fn('Channels.makeReplies')(function* () {
  const database = yield* Database
  const ledger = yield* ChannelLedger
  const provider = yield* ChannelProvider
  const links = yield* ChannelStore
  const threads = yield* ThreadStore

  /** Each accepted chunk is progress; no total deadline cuts off an input-sized reply. */
  const sendReply = Effect.fn('Channels.sendReply')(function* (
    route: ChannelRoute,
    address: ChannelAddress,
    reply: string,
  ) {
    const notSent = () => ledger.record(route.runId, 'not-sent')
    const parts = splitChannelText(channelText(reply), replyLimit)
    if (parts.length === 0) {
      yield* notSent()
      return
    }
    let sent = 0
    yield* Effect.forEach(
      parts,
      Effect.fn('Channels.sendPart')(function* (text) {
        yield* provider.send({ channel: route.channel, address, text }).pipe(
          Effect.timeoutOrElse({
            duration: CHUNK_ACCEPTANCE_LIMIT,
            orElse: () => Effect.fail(new ChannelSendTimedOut({ channel: route.channel })),
          }),
        )
        sent++
      }),
      { discard: true },
    ).pipe(
      // Only a refusal before the first part proves the entire reply was not sent.
      Effect.tapError((error) =>
        sent === 0 &&
        (Predicate.isTagged(error, 'ChannelRecipientMissing') ||
          Predicate.isTagged(error, 'ChannelUnavailable'))
          ? notSent()
          : Effect.void,
      ),
    )
    yield* ledger.record(route.runId, 'sent')
  })

  /**
   * Claim before sending: crashes, partial sends and timeouts remain unknown and are never retried.
   * Spectrum 12.10.1 cannot deduplicate caller keys. The runtime's coalesced response identity is claimed
   * once across joined Runs; app Runs have no route. Proven no-dispatch outcomes are not-sent.
   */
  const ended = Effect.fn('Channels.replyEnded')(function* (event: ChannelEnding) {
    const responseId = Settlement.guards.Completed(event.settlement)
      ? Option.some(event.settlement.responseId)
      : Option.none<ResponseId>()
    const claimed = yield* ledger.claim(event.runId, responseId)
    if (Option.isNone(claimed)) return
    const route = claimed.value
    const link = yield* links.byPerson(route.personId, route.channel)
    if (
      Option.isNone(link) ||
      link.value.since !== route.since ||
      !Option.contains(link.value.threadId, route.threadId) ||
      event.threadId !== route.threadId
    ) {
      yield* ledger.record(event.runId, 'not-sent')
      return
    }
    const thread = yield* findThread(route.threadId).pipe(Effect.provideService(Database, database))
    if (
      Option.isNone(thread) ||
      thread.value.personId !== route.personId ||
      thread.value.companyId !== null
    ) {
      yield* ledger.record(event.runId, 'not-sent')
      return
    }
    if (
      !ThreadAudience.guards.Private((yield* threads.view(thread.value, route.personId)).audience)
    ) {
      yield* ledger.record(event.runId, 'not-sent')
      return
    }
    const address = link.value.address
    const notSent = () => ledger.record(event.runId, 'not-sent')
    yield* Settlement.match(event.settlement, {
      Completed: ({ reply }) => sendReply(route, address, reply),
      Failed: notSent,
      Stopped: notSent,
      Unknown: notSent,
    })
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
