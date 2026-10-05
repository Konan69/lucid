import type { NotificationId, ThreadId } from '@vivid/contracts'
import { noticeFace, NoticeRow, type NoticeFace } from '@vivid/state'
import { Data, Option } from 'effect'
import { bandOf, type Band } from '../../data/lanes'
import { destinationOf, type Destination } from './destination'

/**
 * The Notifications screen as the flat list a native list view scrolls: a heading for each day
 * band that holds something, then that band's rows.
 *
 * The rows, their order and their words are the shared model's (`@vivid/state` `notices.ts`);
 * this adds only what the phone's drawing needs. The bands are the Thread list's own (`Today`,
 * `Yesterday`, `This week`, `Earlier`; `data/lanes.ts`), so the two lists of the app that are
 * ordered by time are read the same way, and a row's short time ("Tue") is never the only thing
 * that says how old it is.
 */
export type Item = Data.TaggedEnum<{
  Heading: { readonly label: Band }
  Entry: {
    /** What the row says, drawn the same on web and phone. */
    readonly face: NoticeFace
    /** Where a press takes the Person. */
    readonly leads: Destination
    /** What a press marks read: every unread notice of the row. */
    readonly unread: ReadonlyArray<NotificationId>
  }
}>
export const Item = Data.taggedEnum<Item>()

/** The notices a press on this row reads. */
const unreadOf = NoticeRow.$match({
  Single: ({ notice }) => (notice.readAt === null ? [notice.id] : []),
  Grouped: ({ unread }) => unread,
})

/**
 * Lays the rows out under their day bands. `rows` arrive newest first, so each band is met once
 * and its heading is written when the band changes; a band with nothing in it has no heading.
 */
export const itemsOf = (
  rows: ReadonlyArray<NoticeRow>,
  gone: ReadonlySet<ThreadId>,
  now: number,
): ReadonlyArray<Item> => {
  const items: Array<Item> = []
  let band = Option.none<Band>()
  for (const row of rows) {
    const face = noticeFace(row)
    const next = bandOf(face.notice.createdAt, now)
    if (!Option.contains(band, next)) {
      band = Option.some(next)
      items.push(Item.Heading({ label: next }))
    }
    items.push(Item.Entry({ face, leads: destinationOf(row, gone), unread: unreadOf(row) }))
  }
  return items
}

/** An item's key. A band is headed at most once; a row's key is the shared model's. */
export const itemKey = Item.$match({
  Heading: ({ label }) => `band:${label}`,
  Entry: ({ face }) => face.key,
})
