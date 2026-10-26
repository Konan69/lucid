import * as NodeCrypto from 'node:crypto'
import { NotFound, ThreadAudience, ThreadId } from '@vivid/contracts'
import { Context, Effect, Layer, Option } from 'effect'
import type { Actor } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { loadDiscordPeople } from '../connections/discord.ts'
import { submissionId } from '../runtime/identity.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import { findThread } from '../threads/access.ts'
import { ThreadStore } from '../threads/store.ts'
import { ChannelLedger } from './ledger.ts'
import type { StoredLink } from './model.ts'
import { ChannelProvider, type ChannelInbound } from './provider.ts'
import { ChannelStore, channelActor } from './store.ts'

/** Linked text uses the app's Thread creation and Conversation admission, always in personal scope. */
const makeInbound = Effect.fn('Channels.makeInbound')(function* () {
  const database = yield* Database
  const links = yield* ChannelStore
  const ledger = yield* ChannelLedger
  const threads = yield* ThreadStore
  const conversation = yield* Conversation
  const provider = yield* ChannelProvider
  const discordPeople = yield* loadDiscordPeople

  /** Deleted or shared Threads cannot inherit phone authority; the next text opens a private Thread. */
  const threadFor = Effect.fn('Channels.threadFor')(function* (
    actor: Actor,
    link: StoredLink,
    text: string,
  ) {
    if (Option.isSome(link.threadId)) {
      const prior = yield* findThread(link.threadId.value).pipe(
        Effect.provideService(Database, database),
      )
      if (
        Option.isSome(prior) &&
        prior.value.personId === actor.person.id &&
        prior.value.companyId === null &&
        ThreadAudience.guards.Private((yield* threads.view(prior.value, actor.person.id)).audience)
      )
        return prior.value.id
    }
    const thread = yield* threads.create(actor, {
      id: ThreadId.make(NodeCrypto.randomUUID()),
      title: text.trim().slice(0, 120),
      projectId: null,
    })
    if (!(yield* links.attach(actor, link, thread.id))) {
      yield* threads.remove(actor.person.id, thread.id)
      return yield* new NotFound({ message: 'Channel disconnected' })
    }
    return thread.id
  })

  /** Deliver text as the linked Person; channel transport never impersonates a runtime signal. */
  const text = Effect.fn('Channels.inboundText')(function* (
    message: ChannelInbound,
    link: StoredLink,
    body: string,
  ) {
    const actor = yield* channelActor(link.personId).pipe(Effect.provideService(Database, database))
    if (message.channel === 'Discord' && !discordPeople.has(actor.person.email.toLowerCase())) {
      yield* Effect.logInfo('Ignored a Discord channel message outside early access')
      return
    }
    const threadId = yield* threadFor(actor, link, body)
    const key = `channel:${message.channel}:${message.id}`
    // Route before admission: even an immediately completed Run must know where its reply belongs.
    yield* ledger.route({
      runId: submissionId(threadId, key),
      personId: actor.person.id,
      channel: message.channel,
      since: link.since,
      threadId,
      place: message.place === undefined ? null : message.place,
    })
    const runId = submissionId(threadId, key)
    yield* conversation
      .deliver({
        threadId,
        personId: actor.person.id,
        speaker: DeliverySpeaker.cases.Acting.make({}),
        message: DeliveryMessage.cases.ChannelText.make({ body }),
        origin: StoredRunOrigin.cases.Message.make({}),
        idempotencyKey: key,
      })
      .pipe(Effect.tapError(() => ledger.record(runId, 'not-sent')))
  })

  /**
   * Claim first, then bound replay by this enrolment. A failure after claiming deliberately drops
   * the text permanently; the worker logs only its failure tag, never words or sender identity.
   */
  const receive = Effect.fn('Channels.inbound')(function* (message: ChannelInbound) {
    if (!(yield* ledger.receive(message))) return
    const link = yield* links.byAddress(message.channel, message.sender)
    if (Option.isNone(link)) {
      if (yield* links.redeem(message.channel, message.sender, message.text)) {
        yield* provider.send({
          channel: message.channel,
          address: message.sender,
          text: "Connected. Message me here, or mention me in any channel, and I'll answer.",
          place: message.place,
        })
        return
      }
      yield* Effect.logInfo('Ignored a channel message without a link')
      return
    }
    if (message.receivedAt < link.value.since) return
    yield* text(message, link.value, message.text)
  })
  return { receive }
})

export class ChannelReceiver extends Context.Service<
  ChannelReceiver,
  Effect.Success<ReturnType<typeof makeInbound>>
>()('vivid/ChannelReceiver') {}
export const channelReceiverLayer = Layer.effect(ChannelReceiver, makeInbound())
