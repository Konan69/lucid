import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { diffRevisions } from '@earendil-works/chord/delta'
import type {
  Conversation,
  ConversationView,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
} from '@earendil-works/pi-durable'
import {
  ConversationFrame,
  emptyConversation,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { Deferred, Effect, Option, Queue, Stream } from 'effect'
import type { StoreUnavailable } from '../storage/errors.ts'
import type { PersonsService } from '../persons.ts'
import { conversationOf, pi, ThreadConversation, type PiRejected } from '../threads.ts'
import { isSubmissionId, outcomeOf } from '../response.ts'
import { projector, unsettled, type Outcome, type Projected, type Viewed } from './project.ts'

const PAGE = 512

/** The newest entry a view shows, by id; a view lists its head marker first, whatever its id. */
const newestOf = (view: ConversationView) =>
  view.entries.reduce<Option.Option<EntryRecord>>(
    (latest, entry) =>
      Option.isSome(latest) && latest.value.id >= entry.id ? latest : Option.some(entry),
    Option.none(),
  )

/** Pi brands its ids in the type system only; an entry id is a positive integer. */
const isEntryId = (value: number): value is EntryId => Number.isSafeInteger(value) && value > 0

/**
 * The entries of a conversation after `after` and up to `through`, oldest first, from storage.
 * Only those: the scan is bounded below by the newest entry already held (`minEntryId`, which
 * Pi's storage applies in its query), so a link that has the first thousand entries reads one
 * entry when one is written, not a thousand and one.
 */
const entriesThrough = Effect.fn('StateLink.entriesThrough')(function* (
  conversation: Pick<Conversation, 'entries'>,
  after: Option.Option<EntryRecord>,
  through: EntryRecord,
) {
  const next = Option.map(after, (known) => known.id + 1)
  const bounds = { maxEntryId: through.id, order: 'ascending' as const }
  const query =
    Option.isSome(next) && isEntryId(next.value) ? { minEntryId: next.value, ...bounds } : bounds
  const entries: EntryRecord[] = []
  let cursor = Option.none<Cursor>()
  for (;;) {
    const page = yield* pi(() =>
      conversation.entries(query, PAGE, Option.getOrUndefined(cursor), BACKGROUND_CONTEXT),
    )
    entries.push(...page.items)
    if (page.next === undefined) return entries
    cursor = Option.some(page.next)
  }
})

/**
 * The transcript as one link knows it: read from storage, never from a view.
 *
 * Pi's view carries only the active range: the newest reset or compaction marker and what
 * follows it (`ConversationView.entries`, Pi `src/harness/view.ts`). What a Person said before
 * that is still theirs to read, so the state is drawn from the whole transcript. A view is used
 * for one thing only: its newest entry says how far the transcript has got. Everything up to
 * there that the link does not have yet is read from storage, so nothing is missed when a view
 * skips ahead: when Pi replaces a slow reader's queued views with its newest one, or when a
 * reset or compaction drops entries from the view before the link was shown them. Reading stops
 * at the view's newest entry so the entries and the view's documents describe the same commit,
 * and starts after the newest entry already held, so the whole transcript is read once, when the
 * link starts.
 */
export const transcript = (conversation: Pick<Conversation, 'entries'>) => {
  const entries: EntryRecord[] = []
  return {
    entries,
    /** Bring the transcript up to what a view shows. Reads storage only when there is more. */
    take: Effect.fn('StateLink.take')(function* (view: ConversationView) {
      const newest = newestOf(view)
      const last = Option.fromUndefinedOr(entries.at(-1))
      if (Option.isNone(newest)) return
      if (Option.isSome(last) && last.value.id >= newest.value.id) return
      entries.push(...(yield* entriesThrough(conversation, last, newest.value)))
    }),
  }
}

/**
 * How the submissions a transcript names ended, from Pi's own records.
 *
 * Pi commits a submission's ending in the commit that ends its run (`endRun`), and that record
 * is the authority: `done`, or `unanswered` with a reason. The runtime's `vivid.response` entry
 * says the same a moment later and can be lost to a kill, so the state does not wait for it. The
 * view carries no submission records, so the ones the transcript does not already settle
 * (`unsettled`: the run answering now, and any run without its response entry) are looked up
 * here before each projection. An ending never changes, so each is looked up until it is known
 * and never again.
 */
const endings = (harness: Harness) => {
  const outcomes = new Map<number, Outcome>()
  return {
    outcomes,
    learn: Effect.fn('StateLink.learn')(function* (view: Viewed) {
      for (const id of unsettled(view)) {
        if (outcomes.has(id) || !isSubmissionId(id)) continue
        const submission = yield* pi(() => harness.submission(id, BACKGROUND_CONTEXT))
        if (submission === undefined) continue
        const record = yield* pi(() => submission.status(BACKGROUND_CONTEXT))
        if (record.status === 'done' || record.status === 'unanswered')
          outcomes.set(id, outcomeOf(record))
      }
    }),
  }
}

/** One projection of what a link knows: its transcript, the view's documents, the endings. */
const reading = Effect.fn('StateLink.reading')(function* (
  known: ReturnType<typeof transcript>,
  ended: ReturnType<typeof endings>,
  view: ConversationView,
) {
  yield* known.take(view)
  const viewed = { entries: known.entries, docs: view.docs }
  yield* ended.learn(viewed)
  return { ...viewed, outcomes: ended.outcomes }
})

/**
 * One Thread's state, once, for a reader that keeps no link (the server's own readers). The
 * same projection and the same whole-transcript rule as the link's first frame.
 */
export const whole: (harness: Harness, threadId: ThreadId) => Effect.Effect<Projected, PiRejected> =
  Effect.fn('StateLink.whole')(function* (harness: Harness, threadId: ThreadId) {
    const conversation = yield* conversationOf(harness, threadId)
    if (Option.isNone(conversation)) return emptyState
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const watch = yield* watching(conversation.value)
        const viewed = yield* reading(transcript(conversation.value), endings(harness), watch.value)
        return projector()(viewed)
      }),
    )
  })

/** The contract's empty state, as the projection's own type. */
const emptyState: Projected = {
  messages: [],
  settlements: [],
  working: emptyConversation.working,
  queued: emptyConversation.queued,
}

/** Pi's watch of a conversation's view, stopped when the scope ends. */
const watching = (conversation: Conversation) =>
  Effect.acquireRelease(
    pi(() => conversation.watch(BACKGROUND_CONTEXT)),
    (watch) => Effect.promise(() => watch.stop()),
  )

/**
 * The Thread's conversation, waiting for it when the Thread has none yet. A Thread nothing was
 * said in has no conversation; its first delivery creates one and records it in a `vivid.thread`
 * document in the same commit (`threads.ts`), and a Session publishes every commit, so the wait
 * is for that commit. Nothing is found when the store closes first.
 */
const awaited = Effect.fn('StateLink.awaited')(function* (harness: Harness, threadId: ThreadId) {
  const created = yield* Deferred.make<void>()
  const unsubscribe = harness.subscribeCommits((publication) => {
    const made = publication.changes.some(
      (change) =>
        change.type === 'document' &&
        change.record.kind === ThreadConversation.definition.kind &&
        change.record.key === threadId,
    )
    if (made) Deferred.doneUnsafe(created, Effect.void)
  })
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
  // Created between the caller's look and the subscription above.
  const already = yield* conversationOf(harness, threadId)
  if (Option.isSome(already)) return already
  yield* Effect.raceFirst(
    Deferred.await(created),
    Effect.promise(() => harness.closed),
  )
  return yield* conversationOf(harness, threadId)
})

/**
 * Follow one Thread and offer its frames: the whole state, then the operations that turn each
 * state into the next.
 *
 * The state is projected from Pi's view at every commit that touches the conversation, and the
 * operations are the difference between two projections (`diffRevisions`), not Pi's own: Pi's
 * operations describe its view, which a screen never sees. Because each frame is computed from
 * the last state sent, a reader that falls behind costs nothing special. `Queue.offer` waits for
 * room, Pi's watch holds at most 100 frames behind it and then replaces them with its newest view
 * (Pi README, "Watching a Conversation"), and the next difference is simply larger. A difference
 * Chord judges larger than the state (it answers with one root replacement) is sent as `Whole`.
 *
 * Pi calls the watch's listener as a Promise callback, one at a time and never inline; `run` is
 * the bridge back into Effect for this link.
 */
const follow = Effect.fn('StateLink.follow')(function* (
  harness: Harness,
  threadId: ThreadId,
  frames: Queue.Enqueue<ConversationFrame>,
) {
  const sent = { state: Option.none<Projected>() }
  const send = (next: Projected) =>
    Effect.suspend(() => {
      const before = sent.state
      sent.state = Option.some(next)
      if (Option.isNone(before))
        return Queue.offer(frames, ConversationFrame.cases.Whole.make({ state: next }))
      const ops = diffRevisions(before.value, next)
      const [first] = ops
      if (first === undefined) return Effect.void
      return Queue.offer(
        frames,
        first[0] === 'r'
          ? ConversationFrame.cases.Whole.make({ state: next })
          : ConversationFrame.cases.Changes.make({ ops }),
      )
    })

  const existing = yield* conversationOf(harness, threadId)
  if (Option.isNone(existing)) yield* send(emptyState)
  const conversation = Option.isSome(existing) ? existing : yield* awaited(harness, threadId)
  if (Option.isNone(conversation)) return

  const watch = yield* watching(conversation.value)
  const known = transcript(conversation.value)
  const ended = endings(harness)
  const project = projector()
  yield* send(project(yield* reading(known, ended, watch.value)))

  const services = yield* Effect.context()
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- The bridge from Pi's watch listener, a Promise callback, into Effect for this link.
  const run = Effect.runPromiseWith(services)
  watch.start((view) =>
    run(
      reading(known, ended, view).pipe(
        Effect.flatMap((viewed) => send(project(viewed))),
        Effect.asVoid,
      ),
    ),
  )
  // The watch ends when this scope stops it, or when the Harness closes or fails.
  yield* Effect.promise(() => watch.closed)
})

/**
 * The frames of one Thread's state for as long as somebody reads them. The Person's
 * conversations are held open for exactly that long: the link runs inside `persons.use`, in a
 * fiber of the stream's scope, so a reader that goes away interrupts it, which stops the watch
 * and lets the Person rest. The stream ends when the Harness closes; the reader opens another.
 */
export const frames = (persons: PersonsService, personId: PersonId, threadId: ThreadId) =>
  Stream.callback<ConversationFrame, PiRejected | StoreUnavailable>(
    (queue) =>
      persons
        .use(personId, ({ harness }) => Effect.scoped(follow(harness, threadId, queue)))
        .pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => Queue.failCause(queue, cause),
            onSuccess: () => Queue.end(queue),
          }),
          Effect.forkScoped,
        ),
    { bufferSize: 16, strategy: 'suspend' },
  )
