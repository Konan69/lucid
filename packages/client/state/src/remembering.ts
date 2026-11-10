import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  Conflict,
  ForgetDone,
  ForgetMemoryRequest,
  ForgetRemaining,
  MemoryCitation,
  MemoryForgetReceipt,
  MemorySource,
  isStandingLayer,
  MemoryAddress,
  MemoryForgetId,
  MemoryCursor,
  MemoryEntry,
  MemoryIndex,
  MemoryLine,
  MemoryPage,
  SavedMemory,
  type MemoryRevision,
} from '@vivid/contracts'
import { Context, Effect, Layer, Option, Predicate, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type { LiveEngine, ProductFailure } from './live.js'

/**
 * What Vivid remembers about a Person, as Settings → Memory shows it on web and phone.
 *
 * The memory lives in the Person's cell, the same memory Vivid reads before every response: the
 * standing pages whole (`self`, `soul`, `person`, `attention`) and the newest entries one line
 * each (`GetMemoryIndex`, `packages/contracts/src/memory.ts`). There is no live watch on it, so
 * the screen reads it when it opens and changes it only through the Person's own correction or
 * forget. A correction is answered with what the cell now holds; a forget is handed to Vivid,
 * which forgets it everywhere, and the screen follows that forget's receipt
 * (`WatchMemoryForget`).
 *
 * Owner: one machine per visit to the screen (`visit`), made when the screen is drawn and let go
 * with it, so every visit reads the memory as it is now. A correction or a forget that is still
 * on its way when the Person leaves runs to its end: the machine is kept for the registry's idle
 * time after its last reader.
 *
 * Reading the list, paging it and changing one entry each wait on the server, so they are this
 * machine's states and not component state set after an answer (`AGENTS.md`, "Lifecycles are
 * machines"). The list and the open entry are two regions of `Shown`: "Show older" can be asked
 * while an entry is open, and both may change the lines `Shown` owns. One attempt of each kind
 * runs at a time; a press while its region waits on the server is not taken.
 */

/** The server could not be asked, or did not answer with the memory. Asking again may work. */
class Unanswered extends Schema.TaggedError<Unanswered>()(
  'MemoryUnanswered',
  {},
  { title: 'MemoryUnanswered' },
) {}

/** The entry changed after the Person was shown it: Vivid, or another device, wrote it since. */
class Moved extends Schema.TaggedError<Moved>()('MemoryMoved', {}, { title: 'MemoryMoved' }) {}

/** The entry is no longer remembered: Vivid, or another device, removed it since. */
class Gone extends Schema.TaggedError<Gone>()(
  'MemoryGone',
  { address: MemoryAddress },
  { title: 'MemoryGone' },
) {}

/** Where a page of older lines starts. */
type Cursor = typeof MemoryCursor.Type

/** One correction as the Person made it, against the revision they were shown. */
interface Correction {
  readonly entry: MemoryEntry
  readonly expected: MemoryRevision
}

/** How the screen asks the Person's cell, through the app's own server connection. */
export interface RememberedService {
  readonly index: Effect.Effect<MemoryIndex, Unanswered>
  readonly older: (after: Cursor) => Effect.Effect<MemoryPage, Unanswered>
  readonly read: (address: MemoryAddress) => Effect.Effect<SavedMemory, Unanswered | Gone>
  readonly correct: (asked: Correction) => Effect.Effect<SavedMemory, Unanswered | Moved | Gone>
  /**
   * Hand the Person's Forget press to Vivid, which forgets it across memory, Watches and queued
   * work in the background; answers the forget whose receipt the screen then reads.
   */
  readonly forget: (entry: SavedMemory) => Effect.Effect<MemoryForgetId, Unanswered | Moved>
}

export class Remembered extends Context.Service<Remembered, RememberedService>()(
  '@vivid/state/remembering/Remembered',
) {}

/** How many older lines one "Show older" brings. */
const PAGE = 30

/** One server call on the engine's socket, with its refusal in the error channel. */
const asking = <Value>(
  engine: LiveEngine,
  call: (client: VividRpcClient['Service']) => Effect.Effect<Value, ProductFailure>,
) =>
  Effect.flatMap(
    engine.run(
      Effect.gen(function* () {
        return yield* call(yield* VividRpcClient)
      }),
    ),
    Effect.fromResult,
  )

/**
 * The server says a stale revision with `Conflict` and a missing entry with `NotFound`
 * (`RpcFailure`; the cell's own `MemoryConflict` does not cross the RPC). Each is handled
 * differently, so each becomes its own failure here; everything else is worth asking again.
 */
const refusal = (address: MemoryAddress) => (failure: ProductFailure) =>
  Predicate.isTagged(failure, 'Conflict')
    ? new Moved()
    : Predicate.isTagged(failure, 'NotFound')
      ? new Gone({ address })
      : new Unanswered()

/** The service over one app's live engine. Web and phone ask the same server the same way. */
const remembered = (engine: LiveEngine) =>
  Layer.succeed(Remembered, {
    index: asking(engine, (client) => client.GetMemoryIndex()).pipe(
      Effect.mapError(() => new Unanswered()),
    ),
    older: (after) =>
      asking(engine, (client) => client.ListMemory({ layer: null, after, limit: PAGE })).pipe(
        Effect.mapError(() => new Unanswered()),
      ),
    read: (address) =>
      asking(engine, (client) => client.ReadMemory(address)).pipe(
        Effect.mapError((failure) =>
          Predicate.isTagged(failure, 'NotFound') ? new Gone({ address }) : new Unanswered(),
        ),
      ),
    correct: (asked) =>
      asking(engine, (client) => client.CorrectMemory(asked)).pipe(
        Effect.mapError(refusal(asked.entry)),
      ),
    forget: (entry) =>
      asking(engine, (client) =>
        client
          .ForgetMemory(
            ForgetMemoryRequest.cases.Entry.make({
              address: { layer: entry.layer, file: entry.file },
              expected: entry.revision,
            }),
          )
          .pipe(
            Effect.map((receipt) => receipt.id),
            // A Settings press carries no plan, so a stale plan is the entry having moved.
            Effect.catchTag('MemoryForgetStale', () =>
              Effect.fail(new Conflict({ message: 'The memory changed' })),
            ),
          ),
      ).pipe(
        Effect.mapError(refusal(entry)),
        Effect.catchTag('MemoryGone', () => Effect.fail(new Unanswered())),
      ),
  })

/** What the list shows: the standing pages whole, the lines below them, and where older ones start. */
const ShownFields = {
  standing: Schema.Array(SavedMemory),
  lines: Schema.Array(MemoryLine),
  /** Where the next older page starts; null once there is nothing older. */
  next: Schema.NullOr(MemoryCursor),
}
type Shown = Schema.Struct.Type<typeof ShownFields>

const RememberingStates = Machine.state({
  states: {
    Reading: {},
    /** The memory could not be read. */
    Unread: {},
    Shown: {
      type: 'parallel',
      fields: ShownFields,
      states: {
        Older: {
          states: {
            Resting: {},
            Paging: { fields: { after: MemoryCursor } },
            /** The last page could not be read; asking again starts from the same place. */
            Unpaged: {},
          },
        },
        Entry: {
          states: {
            Closed: {},
            Opening: { fields: { line: MemoryLine } },
            Unopened: { fields: { line: MemoryLine } },
            Open: { fields: { entry: SavedMemory } },
            /** Open again after a correction or forget found it changed: this is what it says now. */
            Moved: { fields: { entry: SavedMemory } },
            Editing: { fields: { entry: SavedMemory } },
            Saving: { fields: { entry: SavedMemory, change: MemoryEntry } },
            Unsaved: { fields: { entry: SavedMemory } },
            /** Reading an entry again that changed under a correction or a forget. */
            Rereading: { fields: { entry: SavedMemory } },
            Forgetting: { fields: { entry: SavedMemory } },
            /**
             * The Person's press reached the server and Vivid is forgetting it across memory,
             * Watches and queued work; the screen reads that forget's receipt live by its id.
             */
            Handed: { fields: { entry: SavedMemory, forget: MemoryForgetId } },
            Unforgotten: { fields: { entry: SavedMemory } },
            /** The entry was removed before the Person's change reached it. */
            Vanished: {},
          },
        },
      },
    },
  },
})
type RememberingState = Parameters<typeof RememberingStates.matches>[0]

const RememberingEvents = Machine.events({
  Retry: {},
  ShowOlder: {},
  Open: { line: MemoryLine },
  Close: {},
  Edit: {},
  Cancel: {},
  /** The corrected sentence and text, with everything else as the entry had it. */
  Save: { change: MemoryEntry },
  Forget: {},
})

/** Whether two addresses name the same entry. */
const same = (one: MemoryAddress, other: MemoryAddress) =>
  one.layer === other.layer && one.file === other.file

/** The one line an entry is listed as. */
const lineOf = (entry: SavedMemory): MemoryLine => ({
  layer: entry.layer,
  file: entry.file,
  kind: entry.kind,
  description: entry.description,
  basis: entry.basis,
  scope: entry.scope,
  revision: entry.revision,
  updatedAt: entry.updatedAt,
})

/** Where the page after `line` starts. */
const cursorAfter = (line: MemoryLine): Cursor => ({
  layer: line.layer,
  file: line.file,
  updatedAt: line.updatedAt,
})

/**
 * The lines the list shows. A standing page is shown whole above them, so it is not listed a
 * second time if the cell lists it. The cursor is taken from the last line before this, so a
 * page boundary is the cell's own.
 */
const listed = (lines: ReadonlyArray<MemoryLine>) =>
  lines.filter((line) => !isStandingLayer(line.layer))

const nextAfter = (lines: ReadonlyArray<MemoryLine>, more: boolean) => {
  const last = lines.at(-1)
  return more && last !== undefined ? cursorAfter(last) : null
}

/** The list once the cell has answered for one entry: its line as the cell now holds it. */
const withEntry = (shown: Shown, entry: SavedMemory): Shown => ({
  ...shown,
  lines: shown.lines.map((line) => (same(line, entry) ? lineOf(entry) : line)),
})

/** The list without one entry. */
const without = (shown: Shown, address: MemoryAddress): Shown => ({
  ...shown,
  lines: shown.lines.filter((line) => !same(line, address)),
})

/** An entry is opened by reading its whole text; one opening at a time. */
const opening = {
  target: 'Shown.Entry.Opening',
  data: ({ event }: { readonly event: { readonly line: MemoryLine } }) => ({ line: event.line }),
} as const
const close = { target: 'Shown.Entry.Closed' } as const
/** What an open entry takes: another entry, closing, correcting and forgetting it. */
const opened = {
  Open: opening,
  Close: close,
  Edit: {
    target: 'Shown.Entry.Editing',
    data: ({ state }: { readonly state: { readonly entry: SavedMemory } }) => ({
      entry: state.entry,
    }),
  },
  Forget: {
    target: 'Shown.Entry.Forgetting',
    data: ({ state }: { readonly state: { readonly entry: SavedMemory } }) => ({
      entry: state.entry,
    }),
  },
} as const
/** What a correction being written takes: saving it, putting it away, or opening another. */
const editing = {
  Open: opening,
  Close: close,
  Cancel: {
    target: 'Shown.Entry.Open',
    data: ({ state }: { readonly state: { readonly entry: SavedMemory } }) => ({
      entry: state.entry,
    }),
  },
  Save: {
    target: 'Shown.Entry.Saving',
    data: ({
      state,
      event,
    }: {
      readonly state: { readonly entry: SavedMemory }
      readonly event: { readonly change: MemoryEntry }
    }) => ({ entry: state.entry, change: event.change }),
  },
} as const

const RememberingMachine = Machine.make({
  id: 'Remembering',
  root: RememberingStates,
  events: RememberingEvents,
  branches: {
    older: { paging: { target: 'Shown.Older.Paging' } },
    /** Where reading one entry ends when the cell gives it. */
    read: { open: { target: 'Shown.Entry.Open', update: 'Shown' } },
    reread: { moved: { target: 'Shown.Entry.Moved', update: 'Shown' } },
    /** Where reading one entry ends when the cell does not give it. */
    unread: {
      vanished: { target: 'Shown.Entry.Vanished', update: 'Shown' },
      unopened: { target: 'Shown.Entry.Unopened' },
    },
    /** Where a refused correction leads. */
    unsaved: {
      reread: { target: 'Shown.Entry.Rereading' },
      vanished: { target: 'Shown.Entry.Vanished', update: 'Shown' },
      unsaved: { target: 'Shown.Entry.Unsaved' },
    },
    /** Where a refused forget leads. */
    unforgotten: {
      reread: { target: 'Shown.Entry.Rereading' },
      unforgotten: { target: 'Shown.Entry.Unforgotten' },
    },
  },
  effects: {
    index: Remembered.use((service) => service.index),
    older: (after: Cursor) => Remembered.use((service) => service.older(after)),
    read: (address: MemoryAddress) => Remembered.use((service) => service.read(address)),
    correct: (asked: Correction) => Remembered.use((service) => service.correct(asked)),
    forget: (entry: SavedMemory) => Remembered.use((service) => service.forget(entry)),
  },
}).handle({
  initial: { target: 'Reading' },
  states: {
    Reading: {
      invoke: {
        src: 'index',
        onDone: {
          target: 'Shown',
          data: ({ output }) => ({
            standing: output.standing,
            lines: listed(output.lines),
            next: nextAfter(output.lines, output.more),
          }),
        },
        onFailure: { target: 'Unread' },
      },
    },
    Unread: { on: { Retry: { target: 'Reading' } } },
    Shown: {
      states: {
        Older: {
          initial: { target: 'Shown.Older.Resting' },
          states: {
            Resting: {
              on: {
                ShowOlder: {
                  branches: 'older',
                  declinable: true,
                  resolve: (context) =>
                    context.ancestors.Shown.next === null
                      ? context.decline()
                      : context.select.paging({ data: { after: context.ancestors.Shown.next } }),
                },
              },
            },
            Paging: {
              invoke: {
                src: 'older',
                input: ({ state }) => state.after,
                onDone: {
                  target: 'Shown.Older.Resting',
                  update: 'Shown',
                  data: ({ output, ancestors }) => ({
                    target: undefined,
                    update: {
                      standing: ancestors.Shown.standing,
                      lines: [...ancestors.Shown.lines, ...listed(output.entries)],
                      next: output.next,
                    },
                  }),
                },
                onFailure: { target: 'Shown.Older.Unpaged' },
              },
            },
            Unpaged: {
              on: {
                ShowOlder: {
                  branches: 'older',
                  declinable: true,
                  resolve: (context) =>
                    context.ancestors.Shown.next === null
                      ? context.decline()
                      : context.select.paging({ data: { after: context.ancestors.Shown.next } }),
                },
              },
            },
          },
        },
        Entry: {
          initial: { target: 'Shown.Entry.Closed' },
          states: {
            Closed: { on: { Open: opening } },
            Opening: {
              invoke: {
                src: 'read',
                input: ({ state }) => ({ layer: state.line.layer, file: state.line.file }),
                // Closing and opening another can leave an answer for the first queued past it:
                // only the answer for the line this opening is about is taken.
                onDone: {
                  branches: 'read',
                  declinable: true,
                  resolve: ({ output, state, ancestors, select, decline }) =>
                    same(output, state.line)
                      ? select.open({
                          data: { entry: output },
                          update: { data: withEntry(ancestors.Shown, output) },
                        })
                      : decline(),
                },
                onFailure: {
                  branches: 'unread',
                  declinable: true,
                  // Removed since the list was read: it leaves the list and the Person is told.
                  resolve: ({ error, state, ancestors, select, decline }) =>
                    Predicate.isTagged(error, 'MemoryGone')
                      ? same(error.address, state.line)
                        ? select.vanished({
                            update: { data: without(ancestors.Shown, state.line) },
                          })
                        : decline()
                      : select.unopened({ data: { line: state.line } }),
                },
              },
              on: { Close: close },
            },
            Unopened: { on: { Open: opening, Close: close } },
            Open: { on: opened },
            Moved: { on: opened },
            Editing: { on: editing },
            Saving: {
              invoke: {
                src: 'correct',
                input: ({ state }) => ({ entry: state.change, expected: state.entry.revision }),
                onDone: {
                  target: 'Shown.Entry.Open',
                  update: 'Shown',
                  data: ({ output, ancestors }) => ({
                    target: { entry: output },
                    update: withEntry(ancestors.Shown, output),
                  }),
                },
                onFailure: {
                  branches: 'unsaved',
                  resolve: ({ error, state, ancestors, select }) =>
                    Predicate.isTagged(error, 'MemoryMoved')
                      ? select.reread({ data: { entry: state.entry } })
                      : Predicate.isTagged(error, 'MemoryGone')
                        ? select.vanished({
                            update: { data: without(ancestors.Shown, state.entry) },
                          })
                        : select.unsaved({ data: { entry: state.entry } }),
                },
              },
            },
            Unsaved: { on: editing },
            Rereading: {
              invoke: {
                src: 'read',
                input: ({ state }) => ({ layer: state.entry.layer, file: state.entry.file }),
                onDone: {
                  branches: 'reread',
                  declinable: true,
                  resolve: ({ output, state, ancestors, select, decline }) =>
                    same(output, state.entry)
                      ? select.moved({
                          data: { entry: output },
                          update: { data: withEntry(ancestors.Shown, output) },
                        })
                      : decline(),
                },
                onFailure: {
                  branches: 'unread',
                  declinable: true,
                  resolve: ({ error, state, ancestors, select, decline }) =>
                    Predicate.isTagged(error, 'MemoryGone')
                      ? same(error.address, state.entry)
                        ? select.vanished({
                            update: { data: without(ancestors.Shown, state.entry) },
                          })
                        : decline()
                      : select.unopened({ data: { line: lineOf(state.entry) } }),
                },
              },
              on: { Close: close },
            },
            Forgetting: {
              invoke: {
                src: 'forget',
                input: ({ state }) => state.entry,
                onDone: {
                  target: 'Shown.Entry.Handed',
                  update: 'Shown',
                  data: ({ output, state, ancestors }) => ({
                    target: { entry: state.entry, forget: output },
                    update: without(ancestors.Shown, state.entry),
                  }),
                },
                onFailure: {
                  branches: 'unforgotten',
                  resolve: ({ error, state, select }) =>
                    Predicate.isTagged(error, 'MemoryMoved')
                      ? select.reread({ data: { entry: state.entry } })
                      : select.unforgotten({ data: { entry: state.entry } }),
                },
              },
            },
            Handed: { on: { Open: opening, Close: close } },
            Unforgotten: { on: { Open: opening } },
            Vanished: { on: { Open: opening, Close: close } },
          },
        },
      },
    },
  },
})

/** The entry the Person has open, as a screen draws it. */
export const Entry = Schema.TaggedUnion({
  Closed: {},
  Opening: { line: MemoryLine },
  Unopened: { line: MemoryLine },
  Open: { entry: SavedMemory },
  Moved: { entry: SavedMemory },
  Editing: { entry: SavedMemory },
  Saving: { entry: SavedMemory },
  Unsaved: { entry: SavedMemory },
  Rereading: { entry: SavedMemory },
  Forgetting: { entry: SavedMemory },
  Handed: { entry: SavedMemory, forget: MemoryForgetId },
  Unforgotten: { entry: SavedMemory },
  Vanished: {},
})
export type Entry = typeof Entry.Type

/** Whether there is more to show below the list, and where asking for it stands. */
export const Older = Schema.TaggedUnion({
  /** Nothing older is remembered. */
  None: {},
  Resting: {},
  Paging: {},
  Unpaged: {},
})
export type Older = typeof Older.Type

/** The screen's exhaustive reading of one visit. */
export const Remembering = Schema.TaggedUnion({
  Reading: {},
  Unread: {},
  Shown: { ...ShownFields, older: Older, entry: Entry },
})
export type Remembering = typeof Remembering.Type

const olderOf = (state: RememberingState, shown: Shown): Older =>
  RememberingStates.matches(state, 'Shown.Older.Paging')
    ? Older.cases.Paging.make({})
    : RememberingStates.matches(state, 'Shown.Older.Unpaged')
      ? Older.cases.Unpaged.make({})
      : shown.next === null
        ? Older.cases.None.make({})
        : Older.cases.Resting.make({})

const entryOf = (state: RememberingState): Entry =>
  Option.getOrElse(
    Option.firstSomeOf<Entry>([
      Option.map(RememberingStates.get(state, 'Shown.Entry.Opening'), (value) =>
        Entry.cases.Opening.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Unopened'), (value) =>
        Entry.cases.Unopened.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Open'), (value) =>
        Entry.cases.Open.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Moved'), (value) =>
        Entry.cases.Moved.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Editing'), (value) =>
        Entry.cases.Editing.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Saving'), ({ entry }) =>
        Entry.cases.Saving.make({ entry }),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Unsaved'), (value) =>
        Entry.cases.Unsaved.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Rereading'), (value) =>
        Entry.cases.Rereading.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Forgetting'), (value) =>
        Entry.cases.Forgetting.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Handed'), (value) =>
        Entry.cases.Handed.make(value),
      ),
      Option.map(RememberingStates.get(state, 'Shown.Entry.Unforgotten'), (value) =>
        Entry.cases.Unforgotten.make(value),
      ),
      Option.map(
        Option.liftPredicate(state, (at) => RememberingStates.matches(at, 'Shown.Entry.Vanished')),
        () => Entry.cases.Vanished.make({}),
      ),
    ]),
    () => Entry.cases.Closed.make({}),
  )

/** What a screen draws from the machine's state. Before the machine starts it is reading. */
const readingOf = (state: RememberingState): Remembering =>
  Option.match(RememberingStates.get(state, 'Shown'), {
    onSome: (shown) =>
      Remembering.cases.Shown.make({
        ...shown,
        older: olderOf(state, shown),
        entry: entryOf(state),
      }),
    onNone: () =>
      RememberingStates.matches(state, 'Unread')
        ? Remembering.cases.Unread.make({})
        : Remembering.cases.Reading.make({}),
  })

/** The events a screen sends. */
export const events = RememberingEvents

/**
 * The visits for one app's live engine. A visit is one machine, which reads the memory from the
 * cell when it is first read.
 *
 * `begin` makes a new visit and starts its reading at once: the web calls it as Settings opens
 * (`warm.ts`), so the section is drawn on an answer read moments ago. `current` is the visit a
 * screen draws: the one last begun, or a new one when none was. Opening Settings again begins a
 * new visit, so what Vivid learned in between is shown; moving between sections does not.
 */
export const make = (engine: LiveEngine) => {
  const machine = AtomMachine.bind(Atom.runtime(remembered(engine))).factory(RememberingMachine)
  const visit = () => {
    const atoms = machine()
    const reading = Atom.map(atoms.snapshot, (result): Remembering =>
      AsyncResult.isSuccess(result) && result.value.status === 'active'
        ? readingOf(result.value.state)
        : Remembering.cases.Reading.make({}),
    )
    return { reading, send: atoms.send }
  }
  let latest = Option.none<ReturnType<typeof visit>>()
  const begin = () => {
    const made = visit()
    engine.registry.get(made.reading)
    latest = Option.some(made)
    return made
  }
  /** One forget the Person pressed, live until Vivid has carried it out (`WatchMemoryForget`). */
  const forgets = engine.family(
    (id: MemoryForgetId) => id,
    (client, id) => client.WatchMemoryForget({ id }),
  )
  return { begin, current: () => Option.getOrElse(latest, begin), forgets }
}
type Visit = ReturnType<ReturnType<typeof make>['current']>

/** The open entry's address, for the row that stands for it. Closed and vanished have none. */
export const openAddress = (entry: Entry): Option.Option<MemoryAddress> =>
  Entry.match(entry, {
    Closed: () => Option.none(),
    Vanished: () => Option.none(),
    // Handed to Vivid, the entry has left the list; the receipt stands in its place.
    Handed: () => Option.none(),
    Opening: ({ line }) => Option.some(line),
    Unopened: ({ line }) => Option.some(line),
    Open: ({ entry: open }) => Option.some(open),
    Moved: ({ entry: open }) => Option.some(open),
    Editing: ({ entry: open }) => Option.some(open),
    Saving: ({ entry: open }) => Option.some(open),
    Unsaved: ({ entry: open }) => Option.some(open),
    Rereading: ({ entry: open }) => Option.some(open),
    Forgetting: ({ entry: open }) => Option.some(open),
    Unforgotten: ({ entry: open }) => Option.some(open),
  })

/** Whether `line` is the entry `address` names. */
export const isAt = (line: MemoryAddress, address: Option.Option<MemoryAddress>) =>
  Option.exists(address, (at) => same(at, line))

/** What a screen sends a visit: one of `events`. */
export type Sent = Visit['send'] extends Atom.Writable<infer _Read, infer Write> ? Write : never

/** How many of something, said plainly: "1 Watch", "2 Watches". */
const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * What a forget did, in a Person's words, once: web and phone both say it. Counts only; a receipt
 * never carries the forgotten thing, and these words never repeat it.
 */
const doneWords = (done: ForgetDone) => {
  const removed = done.retracted + done.rewritten
  return [
    removed > 0 ? 'Removed from what Vivid remembers' : null,
    done.watches > 0 ? `Stopped ${counted(done.watches, 'Watch', 'Watches')}` : null,
    done.owed > 0 ? `Stopped waiting on ${counted(done.owed, 'thing', 'things')}` : null,
    done.learning > 0 ? 'Stopped what Vivid was still learning from it' : null,
  ].filter(Predicate.isNotNull)
}

/** One thing that can still bring a forgotten fact back, by kind and never by its words. */
const remainingWords = (remaining: ForgetRemaining) =>
  ForgetRemaining.match(remaining, {
    Entry: () => 'Vivid still remembers it in one place',
    Watch: () => 'A Watch could not be stopped',
    Owed: () => 'Something you are waiting on could not be stopped',
    SharedLearning: () => 'It came up in a conversation someone else started',
    Reply: () => 'Another conversation was answering with it when you forgot it',
    Unplanned: () => 'Vivid did not finish forgetting it',
  })

/**
 * Where a forget stands, as a headline and the lines under it. Pending while Vivid is still at
 * it; Forgotten only when nothing that can bring it back remains.
 */
export const forgetWords = (receipt: MemoryForgetReceipt) =>
  MemoryForgetReceipt.match(receipt, {
    Pending: () => ({ headline: 'Vivid is forgetting that everywhere it is kept…', lines: [] }),
    Completed: ({ done }) => ({ headline: 'Forgotten.', lines: doneWords(done) }),
    Blocked: ({ done, remaining }) => ({
      headline: 'Not fully forgotten.',
      lines: [...doneWords(done), ...remaining.map(remainingWords)],
    }),
  })

/**
 * Where an entry came from, one line per source, in a Person's words. A message names its
 * Thread so the screen can open it; the rest only say what wrote the entry.
 */
export const sourcesOf = (entry: SavedMemory) =>
  entry.citations.map((citation) =>
    MemoryCitation.match(citation, {
      ThreadMessage: ({ threadId }) => ({ words: 'Your message', thread: Option.some(threadId) }),
      Run: ({ source }) =>
        MemorySource.match(source, {
          ThreadRun: ({ threadId }) => ({
            words: 'Vivid, in a conversation',
            thread: Option.some(threadId),
          }),
          CellRun: () => ({ words: 'Vivid, after a conversation', thread: Option.none() }),
          HistoryLoad: () => ({ words: 'Carried over from before', thread: Option.none() }),
          Settings: () => ({ words: 'You, in Settings', thread: Option.none() }),
          Forget: () => ({ words: 'Rewritten when you forgot something', thread: Option.none() }),
        }),
    }),
  )

/**
 * What the Dreamer found: its notes in layer `dreams`, which it writes overnight and after a long
 * conversation goes quiet (`packages/agent/runtime/src/dreaming.ts`). Every surface lists them
 * apart from what Vivid remembers, so a Person can see what it researched while they were away.
 */
export const found = (lines: ReadonlyArray<MemoryLine>) =>
  lines.filter((line) => line.layer === 'dreams')

/** Everything else Vivid remembers, as the list has always shown it. */
export const kept = (lines: ReadonlyArray<MemoryLine>) =>
  lines.filter((line) => line.layer !== 'dreams')

/** A forget the Person pressed, before its first receipt has arrived: Vivid is at it. */
export const pendingForget = (id: MemoryForgetId) => MemoryForgetReceipt.cases.Pending.make({ id })
