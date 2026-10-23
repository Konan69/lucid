import * as Schema from 'effect/Schema'

/**
 * Where a Thread lives for its Person.
 *
 * `Conversation` is a Thread the Person talks in: it is listed, searched, counted as unread and
 * offered as recent. `Background` is a Thread Vivid works in on its own, one per Integration event
 * a Watch woke it for (`watches/receiver.ts`). The Person is not watching it; what needs them is
 * posted to the Feed, which opens the Thread by id. So a Background Thread is never listed, and
 * stays readable by id for its owner exactly like any other Thread.
 *
 * Neither place carries data of its own, so the closed set is two literals rather than a tagged
 * union of empty cases; a place with facts of its own becomes a tagged variant then.
 */
export const ThreadPlace = Schema.Literals(['Conversation', 'Background'])
export type ThreadPlace = typeof ThreadPlace.Type

/**
 * Whether a notification may quote a Thread in this place. A Background Thread reaches its Person
 * only through what Vivid posts to the Feed (`feed/`), so nothing that happens there (a Run
 * settling, failing or ending unknown, a follow-up the Person sent from the Feed, an approval or
 * a question raised there) is announced as a notification; the Feed shows what needs the Person.
 * Every place that decides to notify about a Thread asks this, and nowhere else spells the rule.
 */
export const notifiesFrom = (place: ThreadPlace) => place === 'Conversation'
