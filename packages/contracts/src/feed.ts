import * as Schema from 'effect/Schema'
import { DreamPass } from './dreams.js'
import { RunId, ThreadId } from './identity.js'
import { WatchId } from './watches.js'

/**
 * The Feed shows work in every readable Thread the Person owns, including Conversations and
 * Background Threads. Each Thread has one derived card identity even when it has no posted card.
 * Vivid can post words from a Background Thread; another post replaces those words on the same
 * card, so a follow-up updates the work the Person already sees.
 */
export const FeedCardId = Schema.NonEmptyString.pipe(Schema.brand('FeedCardId'))
export type FeedCardId = typeof FeedCardId.Type

/** New until looked at; Done once dealt with. Settled work may remain in the Feed for a day. */
export const FeedCardState = Schema.Literals(['new', 'seen', 'done'] as const)
export type FeedCardState = typeof FeedCardState.Type

const Title = Schema.NonEmptyString.check(Schema.isMaxLength(120))
/** What Vivid says about it, a sentence or two, as plain words, on a card with nothing to draw. */
const Words = Schema.NonEmptyString.check(Schema.isMaxLength(600))
/**
 * The thing itself, drawn: one OpenUI Lang program, the same language a reply's display uses, so
 * every surface draws it with the renderer it already has.
 */
const Display = Schema.NonEmptyString.check(Schema.isMaxLength(20_000))
/** A button under a card with nothing drawn, primary last. Pressing it says these words in the card's Thread as the Person. */
export const FeedAction = Schema.NonEmptyString.check(Schema.isMaxLength(60))
export type FeedAction = typeof FeedAction.Type
const Actions = Schema.Array(FeedAction).check(Schema.isMaxLength(2))

/**
 * What Vivid put on a card. The owner, 29 October 2026, of a card that framed the drawing with a
 * title, a sentence and a bar of its own: "why does it look like we're containing the model?". So
 * a card is one of two things, never both:
 *
 * - `Drawn`: the drawing is the card. Vivid's display fills it and its own buttons answer in the
 *   Thread, as in a reply. The title names the card where it is listed (Handled) and read aloud;
 *   it is not drawn above the display.
 * - `Said`: there is nothing to draw, so the title, a sentence or two, and up to two buttons.
 */
const drawn = { title: Title, display: Display }
const said = { title: Title, words: Words, actions: Actions }

/**
 * Where a card came from, in the Person's words: a note Vivid keeps, a goal, a letter, a recent
 * conversation, a check-in on what someone owes them. Muse's rule: "Every item says in plain words
 * where it came from" (`muse/docs/calls-texts-notifications.md:125`). Vivid writes it; the server
 * keeps what started the work separately, in `FeedProvenance`.
 */
const FeedFrom = Schema.NonEmptyString.check(Schema.isMaxLength(120))
type FeedFrom = typeof FeedFrom.Type

/**
 * How soon a card may interrupt the Person. `ordinary`: it goes on the Feed silently, and at most
 * one such card a day is announced, quietly, in the Person's waking hours and a quiet stretch
 * (`apps/server/src/feed/pace.ts`). `urgent`: it is announced at once, with sound. Konan's
 * decision, 27 October 2026, from Muse's proactive pacing.
 */
export const PostUrgency = Schema.Literals(['ordinary', 'urgent'] as const)
export type PostUrgency = typeof PostUrgency.Type

/**
 * An absolute http or https address with a host; anything else is not a page a Person can open.
 * Contracts run on every surface and have no `URL` global, so the shape is checked by pattern.
 */
const WebAddress = Schema.String.check(
  Schema.isMaxLength(2000),
  Schema.isPattern(/^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/iu),
)
/** A page or record Vivid read the finding from, as the model obtained its link. */
export const FeedSource = Schema.Struct({
  label: Schema.NonEmptyString.check(Schema.isMaxLength(120)),
  url: WebAddress,
})
export interface FeedSource extends Schema.Schema.Type<typeof FeedSource> {}

/**
 * What started the work a card reports, found from the record and never from the model. `Watch`:
 * the Run one Watch event started, with the Watch's id and name as they were then, so the cause
 * outlives the Watch. `Dream`: the Run a Dreamer finding started, and whether the Dreamer ran
 * overnight or after a conversation. `ThreadRun`: the Run that started the Thread, when neither did.
 */
export const FeedCause = Schema.TaggedUnion({
  Watch: { run: RunId, watch: WatchId, watchName: Schema.String, eventId: Schema.NonEmptyString },
  /** The Run a check-in's timer started, with the check-in Watch's id and name as they were. */
  Checkin: { run: RunId, watch: WatchId, watchName: Schema.String },
  Dream: { run: RunId, pass: DreamPass },
  ThreadRun: { run: RunId },
})
export type FeedCause = typeof FeedCause.Type

/** Where a Person can read what a card is based on: a Run in its Thread, or a page on the web. */
export const FeedEvidence = Schema.TaggedUnion({
  ThreadRun: { thread: ThreadId, run: RunId },
  Web: { label: FeedSource.fields.label, url: FeedSource.fields.url },
})
export type FeedEvidence = typeof FeedEvidence.Type

/**
 * Where a card came from. `Recorded`: the Run that posted its current content (`postedBy`, which a
 * follow-up post replaces), what started the work (`cause`, which stays), and what it rests on,
 * the cause's Run first. `Legacy`: a card posted before 29 October 2026, which recorded none of it.
 */
export const FeedProvenance = Schema.TaggedUnion({
  Recorded: {
    postedBy: RunId,
    cause: FeedCause,
    evidence: Schema.NonEmptyArray(FeedEvidence),
  },
  Legacy: {},
})
export type FeedProvenance = typeof FeedProvenance.Type

/** `from` is null on a card posted before cards said where they came from (8 November 2026). */
const shown = { provenance: FeedProvenance, from: Schema.NullOr(FeedFrom) }
export const FeedPost = Schema.TaggedUnion({
  Drawn: { ...drawn, ...shown },
  Said: { ...said, ...shown },
})
export type FeedPost = typeof FeedPost.Type

/** What the work stopped on, waiting for the Person: the same Approval and question a Thread shows. */
export const FeedAsk = Schema.Literals(['approval', 'question'] as const)
export type FeedAsk = typeof FeedAsk.Type

/**
 * One owned Thread's work as the Feed shows it, whether Conversation or Background. The Feed
 * reads Runs, Approvals, questions and any posted card without knowing what started the work.
 * A Conversation normally has no post. The closed life of the work is the union:
 *
 * - `Working`: a Run is going now. It may already have posted (a first look, progress).
 * - `Waiting`: it needs the Person: Vivid posted and they have not settled it, or the work stopped
 *   on an Approval or a question (`asking`), which in the background reaches them only here.
 *   `seen` once the post has been in view.
 * - `Settled`: the Person dealt with it, or Vivid finished without needing them (no post).
 */
const Item = {
  card: FeedCardId,
  /** The owned Thread; pressing an action continues it, and its title opens it. */
  thread: ThreadId,
  /** What brought it, as the Person named it: the Thread's title. */
  from: Schema.String,
}
export const FeedItem = Schema.TaggedUnion({
  Working: { ...Item, since: Schema.Finite, post: Schema.NullOr(FeedPost) },
  Waiting: {
    ...Item,
    at: Schema.Finite,
    post: Schema.NullOr(FeedPost),
    seen: Schema.Boolean,
    asking: Schema.Array(FeedAsk),
  },
  Settled: { ...Item, at: Schema.Finite, post: Schema.NullOr(FeedPost) },
})
export type FeedItem = typeof FeedItem.Type

/** Every item, newest first; the surfaces group them by their stage. */
export const FeedResponse = Schema.Struct({ items: Schema.Array(FeedItem) })

/**
 * What Vivid posts: the card, and the upstream pages or records it read the finding from, as links
 * it actually obtained (none when the event itself is the evidence). The Thread, the Person, the
 * posting Run and the cause come from the Run's own authority, never from the model.
 */
const sources = Schema.Array(FeedSource).check(Schema.isMaxLength(10))
const posted = { sources, from: FeedFrom, urgency: PostUrgency }
export const PostRequest = Schema.TaggedUnion({
  Drawn: { ...drawn, ...posted },
  Said: { ...said, ...posted },
})
export type PostRequest = typeof PostRequest.Type
export const PostOutcome = Schema.TaggedUnion({
  Posted: {},
  Updated: {},
})
export type PostOutcome = typeof PostOutcome.Type

/**
 * A post whose display would draw nothing. `NoRoot`: the program has no `root =` statement, so
 * OpenUI finds no program in it and the card shows an empty band. A model wrote `Card([...])`
 * bare in two of four verify runs on 29 October 2026; the post is refused so it is drawn again.
 */
export class FeedDisplayInvalid extends Schema.TaggedError<FeedDisplayInvalid>()(
  'FeedDisplayInvalid',
  { reason: Schema.Literal('NoRoot') },
  { title: 'The card’s display draws nothing' },
) {}

/**
 * A Person pressing a Feed item to talk about its work: a new Conversation, private to them, in
 * which Vivid is handed that work and speaks first (the owner, 11 November 2026: "Start a new chat
 * with the work's context"). The work's own Thread is left as it is. `conversation` is the new
 * Conversation's id and `key` its first delivery's, both made once per press by the client, so a
 * press sent again after a lost answer finds the same Conversation and the same Run.
 */
/**
 * Why the Person opened the chat. `Looking`: they pressed the item to talk about it. `Answered`:
 * they gave the card its answer (its answer button, or the swipe that says it), which Vivid acts on
 * in the new chat; the owner, 11 November 2026: "it should always open in chat for now when i
 * swipe yes or click the approval button".
 */
export const FeedOpening = Schema.TaggedUnion({
  Looking: {},
  Answered: { words: FeedAction },
})
export type FeedOpening = typeof FeedOpening.Type

export const ResumeFeedItemRequest = Schema.Struct({
  work: ThreadId,
  conversation: ThreadId,
  key: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  opening: FeedOpening,
})
export interface ResumeFeedItemRequest extends Schema.Schema.Type<typeof ResumeFeedItemRequest> {}

/** What a Person does to a card from the Feed. */
export const MarkFeedCardRequest = Schema.Struct({
  card: FeedCardId,
  state: Schema.Literals(['seen', 'done'] as const),
})
