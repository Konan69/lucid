import * as Schema from 'effect/Schema'
import { ThreadId } from './identity.js'

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
/**
 * What Vivid says about it, a sentence or two, as plain words. Absent when the display says it:
 * a card said its one fact three times (the Thread's title, the card's title, then the words)
 * before the drawing, and the owner called it duplicated (29 October 2026).
 */
const Words = Schema.NonEmptyString.check(Schema.isMaxLength(600))
/**
 * The thing itself, drawn: one OpenUI Lang program, the same language a reply's display uses, so
 * every surface draws it with the renderer it already has. Absent when words say it all.
 */
const Display = Schema.NonEmptyString.check(Schema.isMaxLength(20_000))
/**
 * A button under the card, primary last. Pressing it says these words in the card's Thread as the
 * Person. A `$name` in it is replaced by what the Person chose inside the display under that name
 * ("Book $flight" reads "Book Arik Air at 7:10").
 */
export const FeedAction = Schema.NonEmptyString.check(Schema.isMaxLength(60))
const Actions = Schema.Array(FeedAction).check(Schema.isMaxLength(2))

/** What Vivid put on a card: its words, the thing itself drawn, and what the Person can press. */
export const FeedPost = Schema.Struct({
  title: Title,
  words: Schema.NullOr(Words),
  display: Schema.NullOr(Display),
  actions: Actions,
})
export interface FeedPost extends Schema.Schema.Type<typeof FeedPost> {}

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

/** Model input is words only: the Thread and the Person come from the Run's own authority. */
export const PostRequest = FeedPost
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

/** What a Person does to a card from the Feed. */
export const MarkFeedCardRequest = Schema.Struct({
  card: FeedCardId,
  state: Schema.Literals(['seen', 'done'] as const),
})
