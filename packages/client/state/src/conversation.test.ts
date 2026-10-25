import { RpcClientError } from 'effect/rpc/RpcClientError'
import { SocketCloseError } from 'effect/socket/Socket'
import { describe, expect, it } from '@effect/vitest'
import { diffRevisions } from '@earendil-works/chord/delta'
import { RpcConnection, VividRpcClient } from '@vivid/client-runtime'
import {
  ConversationFrame,
  ConversationState,
  ConversationTooLarge,
  emptyConversation,
  Forbidden,
  RuntimeUnavailable,
  ThreadId,
  type ConversationMessage,
} from '@vivid/contracts'
import { Clock, Effect, Latch, Layer, Option, Queue, Schema, Stream, type Cause } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { conversationIn, conversations, Following } from './conversation.js'
import { LiveState, liveStateOf, makeLive } from './live.js'

const thread = ThreadId.make('t1')

/** A Person's message, as the runtime projects one. */
const said = (id: string, text: string): ConversationMessage => ({
  id,
  role: 'user',
  purpose: 'user',
  display: 'visible',
  parts: [{ type: 'text', text, state: 'done' }],
})

/** Vivid's reply while it is being written. */
const replying = (id: string, text: string): ConversationMessage => ({
  id,
  role: 'assistant',
  purpose: 'assistant',
  display: 'visible',
  parts: [{ type: 'text', text, state: 'streaming' }],
})

const conversation = (
  messages: ReadonlyArray<ConversationMessage>,
  working = false,
): ConversationState => ({ messages, settlements: [], working, queued: 0 })

const whole = (state: ConversationState) => ConversationFrame.cases.Whole.make({ state })

/**
 * The frame that turns one state into the next, made the way the runtime makes it
 * (`packages/agent/runtime/src/state/link.ts`): Chord's difference of the two.
 */
const changes = (before: ConversationState, after: ConversationState) =>
  ConversationFrame.cases.Changes.make({ ops: diffRevisions(wire(before), wire(after)) })

/**
 * A state as the JSON it travels as, which is what Chord compares. The contract's own schema
 * encodes it; a state that did not encode to JSON would be a fixture written wrong, and throws.
 */
const wire = (state: ConversationState) => readJson(writeState(state))
const writeState = Schema.encodeSync(ConversationState)
const readJson = Schema.decodeUnknownSync(Schema.MutableJson)

/** What one subscription can end with: a failure of the server's, or simply ending. */
type LinkEnd = RuntimeUnavailable | Forbidden | ConversationTooLarge | RpcClientError | Cause.Done
type Link = Queue.Queue<ConversationFrame, LinkEnd>

/**
 * A Thread's conversation query over a server the test answers by hand: every subscription is a
 * link the test is handed (`opened`) and feeds frame by frame, and every reading the query's
 * atom takes is handed back in order (`readings`).
 */
const followed = Effect.fn('ConversationTest.followed')(function* () {
  const connected = yield* Latch.make(true)
  const opened = yield* Queue.unbounded<Link>()
  const closed = yield* Queue.unbounded<void>()
  /** One subscription: a link of its own, handed to the test to feed. */
  const watch = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const link = yield* Queue.unbounded<ConversationFrame, LinkEnd>()
        yield* Queue.offer(opened, link)
        // Said when the subscription is let go of, however that happens.
        return Stream.fromQueue(link).pipe(Stream.ensuring(Queue.offer(closed, undefined)))
      }),
    )
  const clock = yield* TestClock.testClockWith(Effect.succeed)
  const live = makeLive(
    // Merged, not provided: the clock has to be in what the queries run with, or the wait
    // before a link is opened again would be on the real one.
    Layer.mergeAll(
      Layer.succeed(RpcConnection, { ready: connected.await }),
      Layer.mock(VividRpcClient, {
        // SAFETY: the client's method answers with a Stream unless it is asked for a queue
        // (`asQueue`, effect 4.0.2 `rpc/RpcClient.ts`), and the code under test never asks for
        // one (`conversations`, `conversation.ts`: `client.WatchConversation({ threadId })`).
        WatchConversation: watch as VividRpcClient['Service']['WatchConversation'],
      }),
      Layer.succeed(Clock.Clock, clock),
    ),
  )
  const query = conversations(live).get(thread)
  const readings = yield* Queue.unbounded<LiveState<Following>>()
  const stop = live.registry.subscribe(
    query.atom,
    (result) => void Queue.offerUnsafe(readings, liveStateOf(result)),
    { immediate: true },
  )
  yield* Effect.addFinalizer(() => Effect.sync(stop))
  return {
    opened,
    disconnect: connected.close,
    reconnect: connected.open,
    readings,
    next: Queue.take(readings),
    link: Queue.take(opened),
    /** Asks for the conversation again, as a screen's "Reconnect" does. */
    refresh: () => live.registry.refresh(query.atom),
    /** The last reader leaves. */
    leave: stop,
    left: Queue.take(closed),
  }
})

const live = (state: ConversationState) => LiveState.Ready({ value: Following.Live({ state }) })
const behind = (state: Option.Option<ConversationState>) =>
  LiveState.Ready({ value: Following.Behind({ state }) })

describe('a Thread’s conversation', () => {
  it.effect('is loading until the state arrives whole, and then is that state', () =>
    Effect.gen(function* () {
      const { next, link } = yield* followed()
      expect(yield* next).toEqual(LiveState.Loading())
      const first = conversation([said('entry-1', 'Draft the note')])
      yield* Queue.offer(yield* link, whole(first))
      const reading = yield* next
      expect(reading).toEqual(live(first))
      expect(conversationIn(reading)).toEqual(Option.some(first))
      expect(conversationIn(LiveState.Loading())).toEqual(Option.none())
    }),
  )

  it.effect(
    'applies each change to the state before it, and leaves what did not change alone',
    () =>
      Effect.gen(function* () {
        const { next, link } = yield* followed()
        yield* next
        const open = yield* link
        const asked = conversation([said('entry-1', 'Draft the note')])
        const started = conversation([...asked.messages, replying('run-2', 'Here')], true)
        const more = conversation([...asked.messages, replying('run-2', 'Here is the note')], true)
        yield* Queue.offer(open, whole(asked))
        const first = conversationIn(yield* next)
        yield* Queue.offer(open, changes(asked, started))
        expect(yield* next).toEqual(live(started))
        yield* Queue.offer(open, changes(started, more))
        const last = conversationIn(yield* next)
        expect(last).toEqual(Option.some(more))
        // The message nothing was said about is the very object it was: a row drawn from it is
        // not drawn again for a word that arrived in another.
        expect(Option.map(last, (state) => state.messages[0])).toEqual(
          Option.map(first, (state) => state.messages[0]),
        )
        expect(
          Option.exists(last, (state) =>
            Option.exists(first, (was) => state.messages[0] === was.messages[0]),
          ),
        ).toBe(true)
      }),
  )

  it.effect(
    'drops a link whose change cannot be checked, keeps what it knew, and takes the next whole state as the truth',
    () =>
      Effect.gen(function* () {
        const { next, link, opened } = yield* followed()
        yield* next
        const open = yield* link
        const known = conversation([said('entry-1', 'Draft the note')])
        yield* Queue.offer(open, whole(known))
        yield* next
        // Not an operation at all: a verb Chord does not have.
        yield* Queue.offer(
          open,
          ConversationFrame.cases.Changes.make({ ops: [['x', ['messages']]] }),
        )
        expect(yield* next).toEqual(behind(Option.some(known)))
        // It is opened again after a moment, not at once: a server that keeps sending what
        // cannot be read is not asked in a loop.
        yield* TestClock.adjust('1500 millis')
        expect(yield* Queue.size(opened)).toBe(0)
        yield* TestClock.adjust('375 millis')
        const again = yield* link
        const truth = conversation([
          said('entry-1', 'Draft the note'),
          said('entry-3', 'And send it'),
        ])
        yield* Queue.offer(again, whole(truth))
        expect(yield* next).toEqual(live(truth))
      }),
  )

  it.effect('drops a link whose change does not fit the state it has', () =>
    Effect.gen(function* () {
      const { next, link } = yield* followed()
      yield* next
      const open = yield* link
      const known = conversation([said('entry-1', 'Draft the note')])
      yield* Queue.offer(open, whole(known))
      yield* next
      // A well-formed operation on a message this state does not have.
      yield* Queue.offer(
        open,
        ConversationFrame.cases.Changes.make({
          ops: [['a', ['messages', 4, 'parts', 0, 'text'], '!']],
        }),
      )
      expect(yield* next).toEqual(behind(Option.some(known)))
    }),
  )

  it.effect('does not take a whole state from inside a change, which nothing decoded', () =>
    Effect.gen(function* () {
      const { next, link } = yield* followed()
      yield* next
      const open = yield* link
      yield* Queue.offer(open, whole(emptyConversation))
      yield* next
      yield* Queue.offer(
        open,
        ConversationFrame.cases.Changes.make({ ops: [['r', { messages: 7 }]] }),
      )
      expect(yield* next).toEqual(behind(Option.some(emptyConversation)))
    }),
  )

  it.effect('drops a link that sends a change before any whole state', () =>
    Effect.gen(function* () {
      const { next, link } = yield* followed()
      yield* next
      const open = yield* link
      yield* Queue.offer(open, changes(emptyConversation, conversation([said('entry-1', 'Hello')])))
      // Nothing was known, so nothing is drawn; the link is opened again.
      const reading = yield* next
      expect(reading).toEqual(behind(Option.none()))
      expect(conversationIn(reading)).toEqual(Option.none())
      yield* TestClock.adjust('1875 millis')
      const truth = conversation([said('entry-1', 'Hello')])
      yield* Queue.offer(yield* link, whole(truth))
      expect(yield* next).toEqual(live(truth))
    }),
  )

  it.effect(
    'opens a link again when it ends or the server cannot be reached, and the new whole state replaces the old',
    () =>
      Effect.gen(function* () {
        const { next, link, opened } = yield* followed()
        yield* next
        const first = yield* link
        const before = conversation([said('entry-1', 'Draft the note')])
        yield* Queue.offer(first, whole(before))
        yield* next
        // The runtime closed its side: the subscription simply ends.
        yield* Queue.end(first)
        expect(yield* next).toEqual(behind(Option.some(before)))
        yield* TestClock.adjust('1875 millis')
        const second = yield* link
        // The runtime is being replaced: the subscription is refused for now.
        yield* Queue.fail(second, RuntimeUnavailable.make({ message: 'Starting' }))
        expect(yield* next).toEqual(behind(Option.some(before)))
        // The second link in a row to say nothing: the wait is twice as long.
        yield* TestClock.adjust('3 seconds')
        expect(yield* Queue.size(opened)).toBe(0)
        yield* TestClock.adjust('750 millis')
        const third = yield* link
        // What the new link says is everything: a message gone from it is gone here.
        const after = conversation([said('entry-9', 'Something else entirely')])
        yield* Queue.offer(third, whole(after))
        expect(yield* next).toEqual(live(after))
        // A change on the new link is laid over the new state, never the old.
        const more = conversation([...after.messages, replying('run-10', 'On it')], true)
        yield* Queue.offer(third, changes(after, more))
        expect(yield* next).toEqual(live(more))
      }),
  )

  it.effect('ends for good when the Thread is not this Person’s to read', () =>
    Effect.gen(function* () {
      const { next, link, opened } = yield* followed()
      yield* next
      const open = yield* link
      yield* Queue.offer(open, whole(conversation([said('entry-1', 'Draft the note')])))
      yield* next
      const refusal = Forbidden.make({ message: 'No access' })
      yield* Queue.fail(open, refusal)
      const reading = yield* next
      // What they could read a moment ago stops being drawn, and nothing asks again.
      expect(reading).toEqual(LiveState.Failed({ failure: refusal }))
      expect(conversationIn(reading)).toEqual(Option.none())
      yield* TestClock.adjust('5 seconds')
      expect(yield* Queue.size(opened)).toBe(0)
    }),
  )

  it.effect('keeps known words while the socket is down and reopens on its readiness receipt', () =>
    Effect.gen(function* () {
      const test = yield* followed()
      yield* test.next
      const first = yield* test.link
      const known = conversation([said('entry-1', 'Keep these words')])
      yield* Queue.offer(first, whole(known))
      expect(yield* test.next).toEqual(live(known))
      yield* test.disconnect
      yield* Queue.fail(first, new RpcClientError({ reason: new SocketCloseError({ code: 1006 }) }))
      expect(yield* test.next).toEqual(behind(Option.some(known)))
      yield* TestClock.adjust('1 hour')
      expect(yield* Queue.size(test.opened)).toBe(0)
      const now = yield* Clock.currentTimeMillis
      yield* test.reconnect
      const resumed = yield* test.link
      expect(yield* Clock.currentTimeMillis).toBe(now)
      yield* Queue.offer(resumed, whole(known))
      expect(yield* test.next).toEqual(live(known))
    }),
  )

  it.effect('does not ask again for a conversation the server will not relay at its size', () =>
    Effect.gen(function* () {
      const { next, link, opened } = yield* followed()
      yield* next
      const refusal = new ConversationTooLarge({ threadId: thread, limit: 1024 })
      yield* Queue.fail(yield* link, refusal)
      expect(yield* next).toEqual(LiveState.Failed({ failure: refusal }))
      // Asked again it would be the same size, and each asking reads the whole of it.
      yield* TestClock.adjust('5 seconds')
      expect(yield* Queue.size(opened)).toBe(0)
    }),
  )

  it.effect(
    'does not take a change that fits the state and leaves it something that is not a conversation',
    () =>
      Effect.gen(function* () {
        const known = conversation([said('entry-1', 'Draft the note')])
        // Each is an operation Chord applies: its path is there and its shape is right.
        const breaking: ReadonlyArray<ReadonlyArray<unknown>> = [
          // The list of messages replaced by a number.
          ['s', ['messages'], 7],
          // The list of messages taken away.
          ['d', ['messages']],
          // Something that is not a message put where a message goes.
          ['p', ['messages'], 1, 0, [{ id: 'entry-2', role: 'narrator', parts: 'none' }]],
          // A message that was there made into something that is not one.
          ['d', ['messages', 0, 'role']],
          ['s', ['working'], 'yes'],
          ['s', ['settlements'], [{ submissionId: 7 }]],
          // A count the contract does not take: past what a whole number can safely be.
          ['s', ['queued'], 9_007_199_254_740_992],
        ]
        for (const op of breaking) {
          const { next, link } = yield* followed()
          yield* next
          const open = yield* link
          yield* Queue.offer(open, whole(known))
          yield* next
          yield* Queue.offer(open, ConversationFrame.cases.Changes.make({ ops: [op] }))
          // What was known is still what is drawn, and the link is given up on.
          expect(yield* next).toEqual(behind(Option.some(known)))
        }
      }),
  )

  it.effect(
    'waits longer before each link that follows one that said nothing, up to half a minute, and starts again once one speaks',
    () =>
      Effect.gen(function* () {
        const { next, link, opened } = yield* followed()
        yield* next
        const unreachable = RuntimeUnavailable.make({ message: 'Starting' })
        // 1.5 s, 3 s, 6 s, 12 s, 24 s, then never more than 30 s; each a little longer by an
        // amount that is drawn, so links lost together are not all asked for again together.
        for (const wait of [1500, 3000, 6000, 12_000, 24_000, 30_000, 30_000]) {
          yield* Queue.fail(yield* link, unreachable)
          expect(yield* next).toEqual(behind(Option.none()))
          // Not at the wait itself: something is always added.
          yield* TestClock.adjust(wait)
          expect(yield* Queue.size(opened)).toBe(0)
          // And never more than a quarter of it.
          yield* TestClock.adjust(wait / 4)
        }
        // A link that says the conversation whole: the next loss is the first again.
        const open = yield* link
        yield* Queue.offer(open, whole(emptyConversation))
        expect(yield* next).toEqual(live(emptyConversation))
        yield* Queue.end(open)
        yield* next
        yield* TestClock.adjust(1875)
        yield* link
      }),
  )

  it.effect(
    'says what it knew is no longer current the moment it is asked for again, and keeps it through a link that says nothing',
    () =>
      Effect.gen(function* () {
        const { next, link, refresh } = yield* followed()
        yield* next
        const known = conversation([said('entry-1', 'Draft the note')], true)
        yield* Queue.offer(yield* link, whole(known))
        expect(yield* next).toEqual(live(known))
        refresh()
        // Not `Live`: nothing has been heard on the new link, and it may never answer.
        expect(yield* next).toEqual(behind(Option.some(known)))
        const again = yield* link
        // The new link's first answer is a failure: what was known is still drawn.
        yield* Queue.fail(again, RuntimeUnavailable.make({ message: 'Starting' }))
        expect(yield* next).toEqual(behind(Option.some(known)))
        yield* TestClock.adjust(1875)
        const truth = conversation([said('entry-1', 'Draft the note')])
        yield* Queue.offer(yield* link, whole(truth))
        expect(yield* next).toEqual(live(truth))
      }),
  )

  it.effect('lets go of its link the moment nothing reads it', () =>
    Effect.gen(function* () {
      const { next, link, leave, left } = yield* followed()
      yield* next
      yield* Queue.offer(yield* link, whole(emptyConversation))
      yield* next
      leave()
      // No idle time is waited out: the test clock has not moved, and the link is closed.
      yield* left
    }),
  )
})
