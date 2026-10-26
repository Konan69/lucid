import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  defineDocFamily,
  type Conversation,
  type ConversationId,
  type Harness,
} from '@earendil-works/pi-durable'
import { ThreadId, ThreadOrigin } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'

/**
 * Pi's conversation for one Thread, found by the Thread's id. A session document, because it is
 * read before any conversation is known (Pi `src/documents.ts`: a session family is addressed by
 * kind and key alone). It is written in the commit that creates the conversation, so there is
 * never a conversation nobody can find.
 */
export const ThreadConversation = defineDocFamily<
  { conversationId: ConversationId },
  ConversationId
>({
  // Pi 1.4.0 requires the policy; never writing a base keeps 1.2.0's behaviour (deltas only).
  checkpointWhen: () => false,
  kind: 'vivid.thread',
  version: 1,
  scope: 'session',
  family: true,
  initial: (conversationId) => ({ conversationId }),
})

/** What a conversation is told about its Thread when it is created, and never again. */
interface ThreadFacts {
  [key: string]: string
  threadId: string
  creator: string
  creatorName: string
}

/**
 * The same relation read from the conversation's side: which Thread this is and who started it.
 * A tool call knows only Pi's conversation id; this is how it learns the Thread, and whom a
 * private message is from. Pi has no seeded singleton, so it is the one member `thread` of a
 * family. A fork would not be the same Thread, so it starts without the relation.
 */
export const ConversationThread = defineDocFamily<ThreadFacts, ThreadFacts>({
  // Pi 1.4.0 requires the policy; never writing a base keeps 1.2.0's behaviour (deltas only).
  checkpointWhen: () => false,
  kind: 'vivid.conversation',
  version: 1,
  scope: 'conversation',
  family: true,
  history: 'latest',
  fork: 'initial',
  initial: (facts) => facts,
})
/** The one member of `ConversationThread`'s family; the Flue import writes it too (`flue/carry.ts`). */
export const THREAD_KEY = 'thread'

/**
 * A call into Pi rejected. That is not by itself a failed store: Pi rejects one call for an
 * invalid request or a commit callback that threw and stays sound (Pi README, Errors). A store
 * that did fail closes its Harness, which is what the host acts on (`persons.ts`).
 */
export class PiRejected extends Schema.TaggedError<PiRejected>()(
  'PiRejected',
  { cause: Schema.Defect() },
  { title: 'Conversation library rejected a call' },
) {}

/** No conversation has been created for this Thread in this Person's store. */
export class ThreadUnknown extends Schema.TaggedError<ThreadUnknown>()(
  'ThreadUnknown',
  { threadId: ThreadId },
  { title: 'Thread has no conversation' },
) {}

/**
 * One call into Pi. Every Pi method is a Promise; a rejection is kept as the call's failure with
 * its cause, and the request that made the call answers that it could not be served.
 */
export const pi = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new PiRejected({ cause }) })

/** Two requests created the same Thread at once; the commit that lost rolls back and reads again. */
class CreatedElsewhere extends Schema.TaggedError<CreatedElsewhere>()(
  'CreatedElsewhere',
  {},
  { title: 'Thread conversation created by a concurrent request' },
) {}

const decodeFacts = Schema.decodeUnknownOption(
  Schema.Struct({ threadId: ThreadId, ...ThreadOrigin.fields }),
)

/** The conversation of a Thread, when one exists. This is the handle the state link watches. */
export const conversationOf: (
  harness: Harness,
  threadId: ThreadId,
) => Effect.Effect<Option.Option<Conversation>, PiRejected> = Effect.fn('Threads.conversationOf')(
  function* (harness: Harness, threadId: ThreadId) {
    const mapping = yield* pi(() =>
      harness.snapshot(ThreadConversation, threadId, BACKGROUND_CONTEXT),
    )
    if (mapping === undefined) return Option.none<Conversation>()
    return Option.fromUndefinedOr(
      yield* pi(() => harness.conversation(mapping.conversationId, BACKGROUND_CONTEXT)),
    )
  },
)

/**
 * The Thread's conversation, created on its first delivery. Creating it, recording where to find
 * it and recording who started the Thread are one Pi commit (`createConversation`'s `init` runs in
 * the creating commit, Pi `src/harness/harness.ts` `#create`). `tx.doc` on a family returns the
 * member that is already there, so a commit that finds another conversation recorded throws,
 * which rolls it back, and the Thread's one conversation is read instead.
 */
export const ensureConversation: (
  harness: Harness,
  threadId: ThreadId,
  origin: ThreadOrigin,
) => Effect.Effect<Conversation, PiRejected | ThreadUnknown> = Effect.fn('Threads.ensure')(
  function* (harness: Harness, threadId: ThreadId, origin: ThreadOrigin) {
    const existing = yield* conversationOf(harness, threadId)
    if (Option.isSome(existing)) return existing.value
    const facts = { threadId, creator: origin.creator, creatorName: origin.creatorName }
    const created = yield* Effect.tryPromise({
      try: () =>
        harness.createConversation(
          {
            ownership: { kind: 'ownerless' },
            init: (tx, id) =>
              tx
                .doc(ThreadConversation, threadId, id)
                .then((recorded) => {
                  if (recorded.conversationId !== id) throw new CreatedElsewhere()
                  return tx.doc(ConversationThread, id, THREAD_KEY, facts)
                })
                .then(() => {}),
          },
          BACKGROUND_CONTEXT,
        ),
      catch: (cause) => (cause instanceof CreatedElsewhere ? cause : new PiRejected({ cause })),
    }).pipe(
      Effect.asSome,
      Effect.catchTag('CreatedElsewhere', () => conversationOf(harness, threadId)),
    )
    if (Option.isNone(created)) return yield* new ThreadUnknown({ threadId })
    return created.value
  },
)

/** Which Thread a conversation is, and who started it; absent for a conversation Vivid did not create. */
export const threadOf: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<Option.Option<ThreadOrigin & { readonly threadId: ThreadId }>, PiRejected> =
  Effect.fn('Threads.threadOf')(function* (harness: Harness, conversationId: ConversationId) {
    const facts = yield* pi(() =>
      harness.snapshot(ConversationThread, conversationId, THREAD_KEY, BACKGROUND_CONTEXT),
    )
    return decodeFacts(facts)
  })
