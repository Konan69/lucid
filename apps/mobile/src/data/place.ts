import { LibraryFolderId, LibraryShelf, ProjectId, ThreadId } from '@vivid/contracts'
import { Option, Schema } from 'effect'

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

/** One workspace's place: the Thread in front, when there is one, and the pages over it in order. */
const Place = Schema.Struct({
  thread: Schema.OptionFromNullOr(ThreadId),
  pages: Schema.Array(Page),
})
export type Place = typeof Place.Type

/** Nothing open: the greeting. Where a workspace starts, and where it is when nothing was kept. */
export const NOWHERE: Place = { thread: Option.none(), pages: [] }

/**
 * Every place that is kept: by the server it was on, then by workspace (`workspaceKey`). Only
 * one server's places are ever kept at a time (`keepPlace`); the server is a key and not a field
 * so that a phone pointed at another server finds nothing under its own, and so that nothing
 * kept is simply the empty record.
 */
export const Places = Schema.Record(Schema.String, Schema.Record(Schema.String, Place))
export type Places = typeof Places.Type

const PlacesText = Schema.fromJsonString(Places)
/** Reads the file's text. Text in a shape this build does not know is nothing kept. */
export const decodePlaces = Schema.decodeUnknownOption(PlacesText)
/** The file's text for what is kept. */
export const encodePlaces = Schema.encodeOption(PlacesText)

/** Where the Person was in a workspace on a server, or `NOWHERE` when nothing is kept for it. */
export const placeAt = (kept: Places, origin: string, workspace: string): Place =>
  Option.getOrElse(
    Option.flatMap(Option.fromUndefinedOr(kept[origin]), (places) =>
      Option.fromUndefinedOr(places[workspace]),
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
