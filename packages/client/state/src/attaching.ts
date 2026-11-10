import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { PictureMediaType } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import { Atom } from 'effect/reactivity'

/**
 * Files a Person gives Vivid with what they say, from the phone's composer. A picture travels
 * with the message itself, so Vivid sees it; a document (a PDF, a text or Markdown file) goes to
 * the Person's own shelf of the Library and the message names it, as on the web
 * (`apps/web/src/screen/thread/Attach.tsx`).
 *
 * Owner: one machine per composer, made when the Thread's composer is first drawn and stopped
 * with it (React subtree owned). Nothing here outlives the message being written.
 *
 * Choosing waits on the system's picker and preparing waits on reading or uploading a file, so
 * the tray is a lifecycle, not a list kept in component state: until 26 October 2026 the phone had
 * no way to attach anything (the composer was ported without the reference's attachment button).
 */

/** A file the Person chose or pasted, before it is read or sent. `key` is made by the surface. */
export const Chosen = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  uri: Schema.String,
  mimeType: Schema.String,
  size: Schema.Option(Schema.Finite),
})
export interface Chosen extends Schema.Schema.Type<typeof Chosen> {}

/**
 * A picture as a message carries it (`MessageAttachment`, `@vivid/contracts`): its bytes in
 * base64 and which of the kinds of image a message can carry they are.
 */
export const Picture = Schema.Struct({
  type: Schema.Literal('image'),
  mimeType: PictureMediaType,
  data: Schema.String,
  filename: Schema.String,
})
export interface Picture extends Schema.Schema.Type<typeof Picture> {}

/**
 * One file in the tray. Waiting has not been read or sent yet; Kept is ready to go with the
 * message (a picture with its bytes, or a document already on the Library shelf); Refused says
 * why it cannot go and stays until it is taken off.
 */
export const Item = Schema.TaggedUnion({
  Waiting: { file: Chosen },
  Picture: { file: Chosen, picture: Picture },
  Document: { file: Chosen },
  Refused: { file: Chosen, why: Schema.String },
})
export type Item = typeof Item.Type

/** A file ready to go with the message: a picture with its bytes, or a document on the shelf. */
export const isKept = (item: Item): boolean =>
  Item.guards.Picture(item) || Item.guards.Document(item)

/** The server takes at most four pictures a message (as on the web). */
export const MOST_PICTURES = 4

/** Where files are chosen from: a photo taken now, the photo library, or the Files app. */
export const Source = Schema.Literals(['Camera', 'Photos', 'Files'])
export type Source = typeof Source.Type

/** What a surface does with a file: ask for files, and read or send one. Neither fails. */
export interface AttachingService {
  /** Opens the system's picker for a source. Closing it without choosing is no files. */
  readonly choose: (source: Source) => Effect.Effect<ReadonlyArray<Chosen>>
  /** Reads a picture or sends a document; a file that cannot go answers Refused with why. */
  readonly prepare: (file: Chosen) => Effect.Effect<Item>
}

/** The surface's picker, file reader and Library upload. */
export class Attaching extends Context.Service<Attaching, AttachingService>()(
  '@vivid/state/attaching/Attaching',
) {}

const items = { items: Schema.Array(Item) }

export const TrayStates = Machine.state({
  states: {
    Open: { fields: items },
    /** The picker is up. `attempt` names this opening, so a late answer from another is ignored. */
    Choosing: { fields: { ...items, attempt: Schema.String, source: Source } },
    /** Reading or sending `current`, the first waiting file in `items`. */
    Preparing: { fields: { ...items, current: Chosen } },
  },
})
export type TrayState = Parameters<typeof TrayStates.matches>[0]

export const TrayEvents = Machine.events({
  /** A source in the attach sheet. The presser makes the attempt id. */
  Choose: { attempt: Schema.String, source: Source },
  /** Files that arrived without the picker: pictures pasted into the composer. */
  Add: { files: Schema.Array(Chosen) },
  /** Takes one file off the tray. */
  Remove: { key: Schema.String },
  /** The message went with what was kept: the tray starts again from none. */
  Clear: {},
})

const waiting = (list: ReadonlyArray<Item>) => list.filter(Item.guards.Waiting)
const withWaiting = (list: ReadonlyArray<Item>, files: ReadonlyArray<Chosen>) => [
  ...list,
  ...files.map((file) => Item.cases.Waiting.make({ file })),
]
const without = (list: ReadonlyArray<Item>, key: string) =>
  list.filter((item) => item.file.key !== key)

/** The Preparing data for a tray: its first waiting file, when it has one. */
const preparing = (list: ReadonlyArray<Item>) =>
  Option.map(Option.fromUndefinedOr(waiting(list)[0]), (item) => ({
    items: list,
    current: item.file,
  }))

/**
 * Puts a prepared file in its place. A fifth picture is refused here, where the tray is known,
 * rather than by the surface, which reads one file at a time.
 */
const placed = (list: ReadonlyArray<Item>, ready: Item): ReadonlyArray<Item> => {
  const pictures = list.filter(Item.guards.Picture).length
  const next =
    Item.guards.Picture(ready) && pictures >= MOST_PICTURES
      ? Item.cases.Refused.make({ file: ready.file, why: 'A message can carry four pictures.' })
      : ready
  return list.map((item) => (item.file.key === next.file.key ? next : item))
}

const TrayMachine = Machine.make({
  id: 'AttachTray',
  root: TrayStates,
  events: TrayEvents,
  branches: {
    next: { preparing: { target: 'Preparing' }, open: { target: 'Open' } },
    removed: { kept: { update: 'Preparing' } },
  },
  effects: {
    choose: (input: { readonly attempt: string; readonly source: Source }) =>
      Attaching.use((service) => service.choose(input.source)).pipe(
        Effect.map((files) => ({ attempt: input.attempt, files })),
      ),
    prepare: (file: Chosen) => Attaching.use((service) => service.prepare(file)),
  },
}).handle({
  initial: { target: 'Open', data: () => ({ items: [] }) },
  states: {
    Open: {
      on: {
        Choose: {
          target: 'Choosing',
          data: ({ state, event }) => ({
            items: state.items,
            attempt: event.attempt,
            source: event.source,
          }),
        },
        Add: {
          branches: 'next',
          resolve: (context) => {
            const next = withWaiting(context.state.items, context.event.files)
            return Option.match(preparing(next), {
              onSome: (data) => context.select.preparing({ data }),
              onNone: () => context.select.open({ data: { items: next } }),
            })
          },
        },
        Remove: {
          update: 'Open',
          data: ({ state, event }) => ({ items: without(state.items, event.key) }),
        },
        Clear: { update: 'Open', data: () => ({ items: [] }) },
      },
    },
    Choosing: {
      invoke: {
        src: 'choose',
        input: ({ state }) => ({ attempt: state.attempt, source: state.source }),
        onDone: {
          branches: 'next',
          declinable: true,
          resolve: (context) => {
            if (context.output.attempt !== context.state.attempt) return context.decline()
            const next = withWaiting(context.state.items, context.output.files)
            return Option.match(preparing(next), {
              onSome: (data) => context.select.preparing({ data }),
              onNone: () => context.select.open({ data: { items: next } }),
            })
          },
        },
      },
      on: {
        Remove: {
          update: 'Choosing',
          data: ({ state, event }) => ({
            items: without(state.items, event.key),
            attempt: state.attempt,
            source: state.source,
          }),
        },
        Clear: { target: 'Open', data: () => ({ items: [] }) },
      },
    },
    Preparing: {
      invoke: {
        src: 'prepare',
        input: ({ state }) => state.current,
        onDone: {
          branches: 'next',
          declinable: true,
          // The next file is prepared by entering Preparing again with it as `current`.
          reenter: true,
          resolve: (context) => {
            // Only the answer for this entry's file is taken: Effect Machine 0.46 can queue an
            // answer for an earlier entry past a re-entry.
            if (context.output.file.key !== context.state.current.key) return context.decline()
            const next = placed(context.state.items, context.output)
            return Option.match(preparing(next), {
              onSome: (data) => context.select.preparing({ data }),
              onNone: () => context.select.open({ data: { items: next } }),
            })
          },
        },
      },
      on: {
        Choose: {
          target: 'Choosing',
          data: ({ state, event }) => ({
            items: state.items,
            attempt: event.attempt,
            source: event.source,
          }),
        },
        Add: {
          update: 'Preparing',
          data: ({ state, event }) => ({
            items: withWaiting(state.items, event.files),
            current: state.current,
          }),
        },
        // The file being read or sent cannot be taken off until it is done; any other can.
        Remove: {
          branches: 'removed',
          declinable: true,
          resolve: (context) =>
            context.event.key === context.state.current.key
              ? context.decline()
              : context.select.kept({
                  data: {
                    items: without(context.state.items, context.event.key),
                    current: context.state.current,
                  },
                }),
        },
        Clear: { target: 'Open', data: () => ({ items: [] }) },
      },
    },
  },
})

/** What the composer reads: the files, whether the picker is up, and whether any is on its way. */
export interface Tray {
  readonly items: ReadonlyArray<Item>
  readonly choosing: boolean
  readonly preparing: boolean
}

export const trayOf = (state: TrayState): Tray => ({
  // Each of the three states holds the tray's files; before the machine starts there are none.
  items: Option.getOrElse(
    Option.firstSomeOf([
      Option.map(TrayStates.get(state, 'Open'), (open) => open.items),
      Option.map(TrayStates.get(state, 'Choosing'), (picking) => picking.items),
      Option.map(TrayStates.get(state, 'Preparing'), (busy) => busy.items),
    ]),
    () => [],
  ),
  choosing: TrayStates.matches(state, 'Choosing'),
  preparing: TrayStates.matches(state, 'Preparing'),
})

/** What a message carries for the kept files: pictures beside the words, documents named in them. */
export const carriedBy = (tray: Tray) => ({
  pictures: tray.items.flatMap((item) => (Item.guards.Picture(item) ? [item.picture] : [])),
  lines: tray.items.flatMap((item) =>
    Item.guards.Document(item) ? [`Attached: “${item.file.name}” (in my Library)`] : [],
  ),
})

/** Creates one composer's tray in the app registry with the surface's picker and uploads. */
export const makeTray = (services: Layer.Layer<Attaching>) =>
  AtomMachine.bind(Atom.runtime(services)).make(TrayMachine)
export type TrayAtoms = ReturnType<typeof makeTray>
