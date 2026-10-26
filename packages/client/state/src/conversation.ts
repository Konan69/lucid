import { isTransientSocketReason } from '@vivid/client-runtime'
import { applyImmutable, assertValidOp, isReplace, type Op } from '@earendil-works/chord/delta'
import {
  ConversationFrame,
  ConversationMessage,
  ConversationSettlement,
  ConversationState,
  type ThreadId,
} from '@vivid/contracts'
import { Data, Duration, Effect, Option, Predicate, Random, Ref, Schema, Stream } from 'effect'
import { isFinal, LiveState, type Live, type LiveFamily, type ProductFailure } from './live.js'

/**
 * One Thread's conversation as every client holds it: the state the server relays from the
 * runtime (`ConversationState`, `@vivid/contracts`), kept current over the app's own socket.
 *
 * The server's `WatchConversation` answers with the state whole and then with the changes to it
 * (`ConversationFrame`). The changes are operations of `@earendil-works/chord/delta`, the library
 * the runtime made them with, so that library checks and applies them here. Nothing is replayed:
 * every subscription begins with the state whole, so opening the link again is all that catching
 * up takes, after a dropped socket, a replaced runtime or a frame that could not be applied.
 *
 * The web, the desktop and the phone read the same query (`conversations`), and what a screen
 * says about the link is read from it (`readingOf`, `stream.ts`), never kept beside it.
 */

/**
 * What a client holds of a conversation at one moment.
 *
 * - `Live`: the link is open and `state` is the conversation now.
 * - `Behind`: the link ended or broke and is being opened again. `state` is what was last known,
 *   which goes on being drawn; it is none when the link has never said anything.
 */
export type Following = Data.TaggedEnum<{
  Live: { readonly state: ConversationState }
  Behind: { readonly state: Option.Option<ConversationState> }
}>
export const Following = Data.taggedEnum<Following>()

/**
 * This link cannot be followed any further: a change arrived before the state it changes, or a
 * change could not be checked or applied. It never leaves this module; the link is dropped and
 * opened again, and the state that then arrives whole is the truth.
 */
class LinkUnusable extends Schema.TaggedError<LinkUnusable>()(
  'LinkUnusable',
  {},
  { title: 'Conversation link unusable' },
) {}

/**
 * How long a link that ended or broke waits before it is opened again: a moment the first time,
 * twice as long each time the next link says nothing either, and never more than half a minute.
 * A link that says the conversation whole starts the count again.
 *
 * It is a timer and not the socket's own reopening: a subscription asked for while the socket
 * is down fails at once (`VividRpcClient.layerLive`, `retryTransientErrors` off), and the link
 * is also lost with the socket up, when the runtime behind the server is being replaced. So a
 * conversation nobody can reach is asked for twice a minute, not forty times; a screen that
 * knows better (the socket reopened, the app came back to the front) asks again at once by
 * refreshing the query.
 */
const REOPEN_AFTER_MS = 1500
const REOPEN_AT_MOST_MS = 30_000
/**
 * The wait before the link after `failures` silent ones, a little longer by an amount that is
 * drawn: at least a millisecond and at most a quarter more. Links lost together (a deploy cuts
 * every one at once) are then not all asked for again in the same instant.
 */
const reopenAfter = (failures: number) =>
  Effect.map(Random.nextIntBetween(1, Math.floor(wait(failures) / 4)), (more) =>
    Duration.millis(wait(failures) + more),
  )
const wait = (failures: number) => Math.min(REOPEN_AT_MOST_MS, REOPEN_AFTER_MS * 2 ** failures)

/**
 * The state after one frame's changes. The operations are unknown input (the contract leaves
 * them opaque on purpose), so each is checked by the library that defines them before any is
 * applied. A replacement of the whole state is refused here: the contract sends the state whole
 * only as a `Whole` frame, which is decoded, and a replacement inside `Changes` would put an
 * undecoded value in its place.
 *
 * `applyImmutable` leaves every part of the state it did not touch the very object it was, which
 * is what lets a screen skip the messages that did not change.
 */
const changed = (state: ConversationState, ops: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const checked = yield* Effect.try({
      try: () =>
        ops.map((op): Op => {
          assertValidOp(op)
          return op
        }),
      catch: () => new LinkUnusable(),
    })
    if (checked.some(isReplace)) return yield* new LinkUnusable()
    // A path that is not in the state (a change made for another state) throws in the library.
    const next = yield* Effect.try({
      try: () => applyImmutable<unknown>(state, checked),
      catch: () => new LinkUnusable(),
    })
    return fits(state, next) ? next : yield* new LinkUnusable()
  })

const isMessage = Schema.is(ConversationMessage)
const isSettlements = Schema.is(Schema.Array(ConversationSettlement))

/**
 * Whether what a frame's changes made is still a conversation, given that what they were laid
 * over was one.
 *
 * Chord checks that an operation is well formed and that its path is there; it knows nothing of
 * what a conversation is. `['s', ['messages'], 7]` and a splice that puts a number where a
 * message goes are both operations it applies. So what the changes made is checked against the
 * contract before a screen is given it.
 *
 * Only what changed is checked. `applyImmutable` leaves every part it did not touch the very
 * object it was, and that part was checked when it arrived, so a message that was in the state
 * before, wherever it now stands in the list, needs no second look. A frame that adds words to
 * the reply being written costs one lookup for each message and one reading of that reply's own
 * parts; the transcript is never decoded again. The count is the contract's (`Schema.Int`: a
 * whole number that is safe to count with).
 */
const fits = (was: ConversationState, now: unknown): now is ConversationState => {
  if (!Predicate.isReadonlyObject(now) || !Array.isArray(now.messages)) return false
  const known = new Set<unknown>(was.messages)
  return (
    now.messages.every((message) => known.has(message) || isMessage(message)) &&
    (now.settlements === was.settlements || isSettlements(now.settlements)) &&
    Predicate.isBoolean(now.working) &&
    isCount(now.queued)
  )
}
const isCount = Schema.is(ConversationState.fields.queued)

/**
 * One link, from its first frame to its end: each frame becomes the state after it. The state is
 * none until the link's own `Whole` has arrived, so a change can never be laid over a state from
 * an earlier link.
 */
const linked = <R>(frames: Stream.Stream<ConversationFrame, ProductFailure, R>) =>
  frames.pipe(
    Stream.mapAccumEffect(
      () => Option.none<ConversationState>(),
      (held, frame) =>
        ConversationFrame.match(frame, {
          Whole: ({ state }) => Effect.succeed([Option.some(state), [state]] as const),
          Changes: ({ ops }) =>
            Option.match(held, {
              onNone: () => Effect.fail(new LinkUnusable()),
              onSome: (state) =>
                Effect.map(changed(state, ops), (next) => [Option.some(next), [next]] as const),
            }),
        }),
    ),
  )

/** What a run of links says: the state after each frame, and each time a link was lost. */
type Heard = Data.TaggedEnum<{
  State: { readonly state: ConversationState }
  Lost: {}
}>
const Heard = Data.taggedEnum<Heard>()

/**
 * Link after link, for as long as something reads it. A link that ends (the runtime closed it,
 * the session's check ended it), breaks (the socket dropped, the runtime is being replaced) or
 * cannot be followed is said lost, and after a wait another is opened (`reopenAfter`). Only a
 * refusal that asking again cannot change ends it: the Thread is not there, or not this
 * Person's to read. `failures` is how many links in a row have said nothing.
 */
const links = <R>(
  open: () => Stream.Stream<ConversationFrame, ProductFailure, R>,
  failures: number,
  ready: Effect.Effect<void, ProductFailure, R>,
): Stream.Stream<Heard, ProductFailure, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const spoke = yield* Ref.make(false)
      const disconnected = yield* Ref.make(false)
      return Stream.concat(
        Stream.unwrap(
          Effect.as(
            ready,
            Stream.suspend(() => linked(open())),
          ),
        ).pipe(
          Stream.tap(() => Ref.set(spoke, true)),
          Stream.map((state): Heard => Heard.State({ state })),
          Stream.catchTag('LinkUnusable', () => Stream.empty),
          // Everything but a refusal that asking again cannot change.
          Stream.catchIf(
            (failure) =>
              !isFinal(failure) &&
              (!Predicate.isTagged(failure, 'RpcClientError') ||
                isTransientSocketReason(failure.reason)),
            (failure) =>
              Stream.fromEffect(
                Ref.set(disconnected, Predicate.isTagged(failure, 'RpcClientError')),
              ).pipe(Stream.drain),
          ),
        ),
        Stream.concat(
          Stream.succeed<Heard>(Heard.Lost()),
          // Made when the wait is over, not now: this is the same stream again, without end.
          Stream.unwrap(
            Effect.gen(function* () {
              const now = (yield* Ref.get(spoke)) ? 0 : failures
              // Runtime recovery has no transport signal; a cut socket does and waits only on readiness.
              if (!(yield* Ref.get(disconnected))) yield* Effect.sleep(yield* reopenAfter(now))
              return links(open, now + 1, ready)
            }),
          ),
        ),
      )
    }),
  )

/** What is known after one thing heard, and what a reader is told for it. */
type Carried = readonly [Option.Option<ConversationState>, ReadonlyArray<Following>]

/**
 * A Thread's conversation over `open`, which makes one `WatchConversation` subscription each
 * time it is called. What was last known is carried across a lost link, so a screen goes on
 * drawing the conversation while the next link opens.
 *
 * `last` is what this conversation's query said before it was asked for again (a screen pressed
 * "Reconnect", a phone came back to the front). What it knew is still what is known, but it is
 * no longer being followed: it is said `Behind` at once, until the new link has said the
 * conversation whole. Left as it was it would go on reading as `Live`, a link that never
 * answered included.
 */
export const following = <R>(
  open: () => Stream.Stream<ConversationFrame, ProductFailure, R>,
  last: Option.Option<Following>,
  ready: Effect.Effect<void, ProductFailure, R>,
): Stream.Stream<Following, ProductFailure, R> => {
  const known = Option.flatMap(last, stateOf)
  return Stream.concat(
    Stream.fromIterable(Option.isSome(known) ? [Following.Behind({ state: known })] : []),
    links(open, 0, ready).pipe(
      Stream.mapAccum(
        () => known,
        (held, heard) =>
          Heard.$match(heard, {
            State: ({ state }): Carried => [Option.some(state), [Following.Live({ state })]],
            Lost: (): Carried => [held, [Following.Behind({ state: held })]],
          }),
      ),
    ),
  )
}

/** The conversation in what a query said, when it knew one. */
const stateOf = (said: Following): Option.Option<ConversationState> =>
  Following.$match(said, {
    Live: ({ state }) => Option.some(state),
    Behind: ({ state }) => state,
  })

/** The part of an app's live layer this module builds on (`followed`, `live.ts`). */
type Engine = Pick<Live, 'followed'>

/**
 * Every Thread's conversation as a live query of an app's live layer, one per Thread.
 *
 * Unlike the layer's other queries it is let go the moment nothing reads or holds it
 * (`followed`): each one is a link of its own from the server to the runtime, and holds the
 * whole transcript. How long a Thread's conversation is kept after its screen has gone is the
 * app's to say, by holding it (the web holds the last few, `apps/web/src/data/conversation.ts`).
 */
export const conversations = (engine: Engine): LiveFamily<ThreadId, Following> =>
  engine.followed(
    (id: ThreadId) => id,
    (client, threadId, last, ready) =>
      following(() => client.WatchConversation({ threadId }), last, ready),
  )

/**
 * The conversation a screen draws from a query's reading, when there is one: the state of an
 * open link, or what was last known while the next link opens.
 */
export const conversationIn = (reading: LiveState<Following>): Option.Option<ConversationState> =>
  LiveState.$match(reading, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Ready: ({ value }) => stateOf(value),
  })

/**
 * Whether a query's reading is the conversation as its link has it now: the link is open and has
 * said the conversation whole. Not while the link is being opened again, when what is drawn is
 * what was last known. Only a conversation followed live can say that something is not in it.
 */
export const isLive = (reading: LiveState<Following>): boolean =>
  LiveState.$is('Ready')(reading) && Following.$is('Live')(reading.value)
