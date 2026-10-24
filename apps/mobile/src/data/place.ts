import { LibraryFolderId, LibraryShelf, ProjectId, ThreadId } from '@vivid/contracts'
import { Array as Arr, Option, Record, Schema } from 'effect'

/**
 * Where the Person was: which Thread the first screen showed and which pages were open over it,
 * for each workspace, kept on the phone so the app opens where it was left.
 *
 * A phone ends an app it is not showing whenever it wants the memory, and an update restarts it
 * (`data/updating.ts`). Both used to bring the Person back to the greeting with nothing open: the
 * Thread in front lived in a store made new at each launch (`data/front.ts`) and the stack was
 * never written down. To the Person that is the app forgetting what they were doing.
 *
 * This module is what a place is and how it is written down. The phone's file and the atoms over
 * it are `data/placed.ts`, as `data/held.ts` is to `data/session.ts`.
 */

/**
 * A page over the first screen that can be drawn again from its name and what it was opened
 * with. The bottom sheets (`Account`, `NameAccount`, `Key`) are left out on purpose: each is a
 * step in something the Person was doing with a press that is no longer there, so coming back
 * finds the page they were opened over.
 */
const Page = Schema.Union([
  Schema.Struct({
    name: Schema.Literals([
      'Computer',
      'Feed',
      'Library',
      'Projects',
      'Settings',
      'People',
      'Memory',
      'Texting',
      'Integrations',
      'Notifications',
    ] as const),
  }),
  Schema.Struct({
    name: Schema.Literal('Folder'),
    params: Schema.Struct({ shelf: LibraryShelf, id: LibraryFolderId, name: Schema.String }),
  }),
  Schema.Struct({ name: Schema.Literal('Project'), params: Schema.Struct({ id: ProjectId }) }),
])
export type Page = typeof Page.Type

/** Reads one route of the stack as a page, when it is one that can be drawn again. */
export const pageOf = Schema.decodeUnknownOption(Page)

/**
 * One workspace's place: the Thread in front, when there is one, the pages over it in order, and
 * when the Person was last there (milliseconds since the epoch).
 */
const Place = Schema.Struct({
  thread: Schema.OptionFromNullOr(ThreadId),
  pages: Schema.Array(Page),
  at: Schema.Finite,
})
export type Place = typeof Place.Type

/** Nothing open: the greeting. Where a workspace starts, and where it is when nothing was kept. */
export const NOWHERE: Place = { thread: Option.none(), pages: [], at: 0 }

/**
 * How long a place is worth coming back to, in milliseconds. A Person who comes back sooner
 * finds what they left; one who comes back later finds the greeting, somewhere to start a new
 * Thread, with nothing open over it.
 *
 * A place used to be kept for ever, so every launch opened on the last Thread and the app always
 * had a conversation open. The owner asked for a new Thread to be what opens, with the kept one
 * expiring (24 October 2026). Fifteen minutes covers a glance at another app and back, and
 * not coming back to the phone after a break. The shell applies the same length to an app that
 * was never ended, only put away (`useAfreshOnReturn`, `App.tsx`).
 */
export const KEPT_FOR = 15 * 60 * 1000

/** Whether a place last visited at `at` is too old to come back to at `now`. */
export const forgotten = (at: number, now: number): boolean => now - at > KEPT_FOR

/**
 * Every place that is kept: by the server it was on, then by workspace (`workspaceKey`). Only
 * one server's places are ever kept at a time (`keepPlace`); the server is a key and not a field
 * so that a phone pointed at another server finds nothing under its own, and so that nothing
 * kept is simply the empty record.
 */
export const Places = Schema.Record(Schema.String, Schema.Record(Schema.String, Place))
export type Places = typeof Places.Type

const PlacesText = Schema.fromJsonString(Places)

/**
 * A place as the file holds it, before its pages are read. The pages are left unread here so that
 * each is read on its own (`pageOf`) in `decodePlaces`.
 */
const KeptPlace = Schema.Struct({
  thread: Schema.OptionFromNullOr(ThreadId),
  pages: Schema.Array(Schema.Unknown),
  at: Schema.Finite,
})
const KeptText = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, KeptPlace)),
)
const readKept = Schema.decodeUnknownOption(KeptText)

/** One kept place with each of its pages read on its own; a page that does not read is dropped. */
const placeOfKept = (kept: typeof KeptPlace.Type): Place => ({
  thread: kept.thread,
  pages: Arr.getSomes(kept.pages.map((page) => pageOf(page))),
  at: kept.at,
})

/**
 * Reads the file's text. Text in a shape this build does not know is nothing kept (a file written
 * before places carried `at` is one, and opens on the greeting, as a place that old would), but a page this
 * build no longer draws is only that page: it is dropped, and the Thread in front, the other
 * pages and every other workspace are kept as they were. The file is written by older builds too,
 * and a page can be retired (Routines went on 16 October 2026); read as one schema, a single
 * retired page made the whole file unreadable, every workspace opened on the greeting, and the
 * next write put that empty record over what had been kept.
 */
export const decodePlaces = (text: string): Option.Option<Places> =>
  Option.map(readKept(text), (kept) =>
    Record.map(kept, (workspaces) => Record.map(workspaces, placeOfKept)),
  )
/** The file's text for what is kept. */
export const encodePlaces = Schema.encodeOption(PlacesText)

/**
 * Where the Person was in a workspace on a server, or `NOWHERE` when nothing is kept for it or
 * what is kept is too old to come back to at `now` (`KEPT_FOR`).
 */
export const placeAt = (kept: Places, origin: string, workspace: string, now: number): Place =>
  Option.getOrElse(
    Option.filter(
      Option.flatMap(Option.fromUndefinedOr(kept[origin]), (places) =>
        Option.fromUndefinedOr(places[workspace]),
      ),
      (place) => !forgotten(place.at, now),
    ),
    () => NOWHERE,
  )

/**
 * What is kept once a workspace's place has changed. Places kept for another server are dropped:
 * this phone is no longer on it, and its Threads are not this server's.
 */
export const withPlace = (
  kept: Places,
  origin: string,
  workspace: string,
  place: Place,
): Places => ({
  [origin]: {
    ...Option.getOrElse(Option.fromUndefinedOr(kept[origin]), () => ({})),
    [workspace]: place,
  },
})
