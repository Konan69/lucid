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
 * - `Gone`: the row is about a Thread the server has said is not there for this Person (deleted,
 *   or no longer theirs to see). It says so and does not open a screen that could only say the
 *   same.
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
 * `gone` is every Thread the server has refused this Person in this session: they opened it and
 * its own live query answered `NotFound` (`data/live.ts`). Only that makes a row read as
 * unavailable. It used to be "not in the Thread list", but the list is the 500 Threads that
 * moved most recently (`apps/server/src/threads/store.ts`) and is not every Thread a Person can
 * open: a notice about an older one was called gone and could not be pressed, though the Thread
 * was a tap away. So a row about a Thread always opens it, and the Thread's own screen, which
 * asks the server about that one Thread, is what says when it is not there.
 */
export const destinationOf = (row: NoticeRow, gone: ReadonlySet<ThreadId>): Destination =>
  NoticeRow.$match(row, {
    Single: ({ notice }) =>
      Option.match(invitationIn(notice), {
        onNone: () => Destination.Nowhere(),
        onSome: (id) => Destination.Invitation({ id }),
      }),
    Grouped: ({ threadId }) =>
      gone.has(threadId) ? Destination.Gone() : Destination.Thread({ id: threadId }),
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
