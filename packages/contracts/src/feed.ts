import * as Schema from 'effect/Schema'
import { ThreadId } from './identity.js'

/**
 * The Feed is how Vivid brings things to a Person. Work Vivid does on its own (an Integration's
 * event waking it) runs in a background Thread the Person never sees in their Thread list; the
 * only thing that reaches them from it is a card Vivid chose to post. Nothing worth their
 * attention means no card.
 *
 * A card is the face of one background Thread: Vivid posting again from the same Thread
 * replaces the card's words rather than adding a second card, so a follow-up (the Person pressed
 * one of its buttons and Vivid acted) updates what they already see.
 */
export const FeedCardId = Schema.NonEmptyString.pipe(Schema.brand('FeedCardId'))
export type FeedCardId = typeof FeedCardId.Type

/** New until the Person has looked at it; Done once they have dealt with it, which takes it off the Feed. */
export const FeedCardState = Schema.Literals(['new', 'seen', 'done'] as const)
export type FeedCardState = typeof FeedCardState.Type

const Title = Schema.NonEmptyString.check(Schema.isMaxLength(120))
/** What Vivid says about it, a sentence or two, as plain words. */
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
  words: Words,
  display: Schema.NullOr(Display),
  actions: Actions,
})
export interface FeedPost extends Schema.Schema.Type<typeof FeedPost> {}

/** What the work stopped on, waiting for the Person: the same Approval and question a Thread shows. */
export const FeedAsk = Schema.Literals(['approval', 'question'] as const)
export type FeedAsk = typeof FeedAsk.Type

/**
 * One piece of Vivid's own work, as the Feed shows it: the face of one background Thread. The Feed
 * knows nothing of where work comes from (an Integration's event, a timer, whatever wakes Vivid
 * next): every source is a background Thread, and whatever it has to show is a post Vivid
 * composed, drawn by the same renderer. So a new source needs no Feed code. What the Feed does
 * know is the closed life of the work, and that is the union:
 *
 * - `Working`: a Run is going now. It may already have posted (a first look, progress).
 * - `Waiting`: it needs the Person: Vivid posted and they have not settled it, or the work stopped
 *   on an Approval or a question (`asking`), which in the background reaches them only here.
 *   `seen` once the post has been in view.
 * - `Settled`: the Person dealt with it, or Vivid finished without needing them (no post).
 */
const Item = {
  card: FeedCardId,
  /** The background Thread; pressing an action continues it, and its title opens it. */
  thread: ThreadId,
  /** What brought it, as the Person named it: the background Thread's title. */
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

/** What a Person does to a card from the Feed. */
export const MarkFeedCardRequest = Schema.Struct({
  card: FeedCardId,
  state: Schema.Literals(['seen', 'done'] as const),
})
