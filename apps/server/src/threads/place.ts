import * as Schema from 'effect/Schema'
import { NotificationOpens, type ThreadId } from '@vivid/contracts'

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
 * Whether the work in a Thread in this place is announced as a notification. A Background Thread
 * reaches its Person through the Feed (`feed/`), so a Run settling, failing or ending unknown
 * there, a follow-up the Person sent from the Feed, or a `notify_person` call is not announced.
 * What Vivid puts in front of the Person from there is: a post, a question, an Approval. Each of
 * those notifies whatever the place, and opens where it is shown (`opensAt`).
 */
export const notifiesFrom = (place: ThreadPlace) => place === 'Conversation'

/**
 * Where a notice about this Thread opens when pressed. A Background Thread is never listed; its
 * posts, questions and Approvals are drawn on the Feed, so its notices open the Feed. Every other
 * Thread opens itself. A notice about no Thread is a Company invitation and opens Notifications;
 * its callers say that, since they hold no Thread.
 */
export const opensAt = (thread: {
  readonly id: ThreadId
  readonly place: ThreadPlace
}): NotificationOpens =>
  thread.place === 'Background'
    ? NotificationOpens.cases.Feed.make({})
    : NotificationOpens.cases.Thread.make({ threadId: thread.id })
