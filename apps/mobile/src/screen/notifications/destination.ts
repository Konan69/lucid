import type { InvitationId, ThreadId } from '@vivid/contracts'
import { invitationIn, NoticeRow } from '@vivid/state'
import { Data, Option } from 'effect'

/**
 * Where pressing a row of the Notifications screen takes the Person. It is worked out here, away
 * from React, because a row is drawn differently for each answer (a button, a link that leaves
 * the app, or plain text) and a press must never do nothing.
 *
 * - `Thread`: the row is about a Thread the Person can open.
 * - `Invitation`: the row is an invitation to a Company. The phone has no screen that accepts
 *   one, so it opens the web's own invitation page in the phone's browser.
 * - `Gone`: the row is about a Thread that is not in the Person's list any more (deleted, or no
 *   longer theirs to see). It says so and does not open a screen that could only say the same.
 * - `Nowhere`: a notice about no Thread that carries no invitation. There is nothing to open.
 */
export type Destination = Data.TaggedEnum<{
  Thread: { readonly id: ThreadId }
  Invitation: { readonly id: InvitationId }
  Gone: {}
  Nowhere: {}
}>
export const Destination = Data.taggedEnum<Destination>()

/**
 * Where a row leads.
 *
 * `known` is every Thread the Person can see, once the Thread list has answered. Until it has,
 * a row about a Thread is taken to be openable: calling a Thread gone because the list is still
 * on its way would refuse a press that works a moment later. The server lists at most the 500
 * Threads that moved most recently (`apps/server/src/threads/store.ts`), so for a Person with
 * more than that, a notice about one of the older ones also reads as gone here.
 */
export const destinationOf = (
  row: NoticeRow,
  known: Option.Option<ReadonlySet<ThreadId>>,
): Destination =>
  NoticeRow.$match(row, {
    Single: ({ notice }) =>
      Option.match(invitationIn(notice), {
        onNone: () => Destination.Nowhere(),
        onSome: (id) => Destination.Invitation({ id }),
      }),
    Grouped: ({ threadId }) =>
      Option.exists(known, (threads) => !threads.has(threadId))
        ? Destination.Gone()
        : Destination.Thread({ id: threadId }),
  })

/** Whether pressing the row goes somewhere, in the app or out of it. */
export const opens = Destination.$is('Thread')
export const leaves = Destination.$is('Invitation')

/**
 * Whether a row answers a press at all. One that leads somewhere always does. One that leads
 * nowhere does only while something in it is unread, because then the press reads it; once it is
 * read it is text, and is drawn as text.
 */
export const answers = (leads: Destination, unread: number): boolean =>
  opens(leads) || leaves(leads) || unread > 0
