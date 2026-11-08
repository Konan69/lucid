import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { ArtifactBody, ArtifactId } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Predicate, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/**
 * A Person revising one of a Thread's documents by hand, the same on web, phone and desktop.
 *
 * The editor is open from `Edit` until `Close` or a save the server took. A save is a new version
 * made from the version the Person started on (`ReviseArtifact`, compare-and-swap on `from`). If
 * Vivid or someone else added a version meanwhile, the server refuses it with `ArtifactChanged`,
 * and the editor says so and keeps what the Person wrote: saving again saves over the newer
 * version, on purpose, and closing drops their text. Nothing is ever overwritten silently.
 *
 * It is session-owned, like `naming`: one editor at a time, and a refusal outlives the sheet or
 * dialog being closed and opened again. Each Save carries its own attempt id, and `Saving` is
 * entered again from `Changed` and `Refused`, so every outcome says the attempt it answers and is
 * declined when that is not the current one (`owed.ts`, the 0.46 queued-outcome rule).
 *
 * What is typed is not part of the machine: it is the field's own text until Save hands it over.
 */

/** Names one Save. The presser makes it; the outcome says it back. */
export const AttemptId = Schema.String.pipe(Schema.brand('RevisingAttemptId'))
export type AttemptId = typeof AttemptId.Type

const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** One Save: which document, from which version, with what text. */
const Revision = Schema.Struct({
  attempt: AttemptId,
  id: ArtifactId,
  from: Version,
  body: ArtifactBody,
})
export type Revision = typeof Revision.Type

/** The document moved on while it was being edited; `version` is the newest now. */
export class Moved extends Schema.TaggedError<Moved>()(
  'RevisionMoved',
  { revision: Revision, version: Version },
  { title: 'RevisionMoved' },
) {}

/** The save did not land for another reason (the connection, the server). Saving again may. */
export class Unsaved extends Schema.TaggedError<Unsaved>()(
  'RevisionUnsaved',
  { revision: Revision },
  { title: 'RevisionUnsaved' },
) {}

/** The surface owns the authenticated call. */
export interface RevisingService {
  readonly revise: (revision: Revision) => Effect.Effect<void, Moved | Unsaved>
}

/** Each app supplies its own connection to the server. */
export class Reviser extends Context.Service<Reviser, RevisingService>()(
  '@vivid/state/revising/Reviser',
) {}

const Opened = { id: ArtifactId, from: Version }

const States = Machine.state({
  states: {
    Closed: {},
    Editing: { fields: Opened },
    Saving: { fields: Revision.fields },
    /** The Person's text is kept; `newest` is the version a second Save will be made from. */
    Changed: { fields: { id: ArtifactId, newest: Version, body: ArtifactBody } },
    Refused: { fields: Revision.fields },
  },
})

const Events = Machine.events({
  Edit: Opened,
  Close: {},
  Save: { attempt: AttemptId, body: ArtifactBody },
})

const close = { target: 'Closed' } as const
/** The Save pressed, made from `from`, as the attempt `Saving` holds. */
const attemptFrom = (
  event: { readonly attempt: AttemptId; readonly body: string },
  id: ArtifactId,
  from: number,
) => ({ attempt: event.attempt, body: event.body, id, from })
const sameAttempt = (left: Revision, right: Revision) => left.attempt === right.attempt

const machine = Machine.make({
  id: 'ArtifactRevision',
  root: States,
  events: Events,
  branches: {
    saved: {
      closed: { target: 'Closed' },
      changed: { target: 'Changed' },
      refused: { target: 'Refused' },
    },
  },
  effects: {
    revise: (revision: Revision) =>
      Reviser.use((service) => service.revise(revision)).pipe(Effect.as(revision)),
  },
}).handle({
  initial: { target: 'Closed' },
  states: {
    Closed: {
      on: {
        Edit: { target: 'Editing', data: ({ event }) => ({ id: event.id, from: event.from }) },
      },
    },
    Editing: {
      on: {
        Save: {
          target: 'Saving',
          data: ({ state, event }) => attemptFrom(event, state.id, state.from),
        },
        Close: close,
      },
    },
    Saving: {
      invoke: {
        src: 'revise',
        input: ({ state }) => Revision.make(state),
        onDone: {
          branches: 'saved',
          declinable: true,
          resolve: (context) =>
            sameAttempt(context.output, context.state)
              ? context.select.closed()
              : context.decline(),
        },
        onFailure: {
          branches: 'saved',
          declinable: true,
          resolve: (context) => {
            const { error } = context
            if (!sameAttempt(error.revision, context.state)) return context.decline()
            return Predicate.isTagged(error, 'RevisionMoved')
              ? context.select.changed({
                  data: { id: error.revision.id, newest: error.version, body: error.revision.body },
                })
              : context.select.refused({ data: error.revision })
          },
        },
      },
      on: { Close: close },
    },
    Changed: {
      on: {
        Save: {
          target: 'Saving',
          data: ({ state, event }) => attemptFrom(event, state.id, state.newest),
        },
        Close: close,
      },
    },
    Refused: {
      on: {
        Save: {
          target: 'Saving',
          data: ({ state, event }) => attemptFrom(event, state.id, state.from),
        },
        Close: close,
      },
    },
  },
})

/** The editor's exhaustive reading, including startup before the machine accepts events. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Closed: {},
  Editing: Opened,
  Saving: { id: ArtifactId, body: ArtifactBody },
  Changed: { id: ArtifactId, newest: Version, body: ArtifactBody },
  Refused: { id: ArtifactId, body: ArtifactBody },
})
export type Reading = typeof Reading.Type

/** Session-owned: one editor for the app, read by every screen that opens a document. */
export const make = (services: Layer.Layer<Reviser>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Editing'), ({ id, from }) =>
          Reading.cases.Editing.make({ id, from }),
        ),
        Option.map(States.get(state, 'Saving'), ({ id, body }) =>
          Reading.cases.Saving.make({ id, body }),
        ),
        Option.map(States.get(state, 'Changed'), ({ id, newest, body }) =>
          Reading.cases.Changed.make({ id, newest, body }),
        ),
        Option.map(States.get(state, 'Refused'), ({ id, body }) =>
          Reading.cases.Refused.make({ id, body }),
        ),
      ]),
      () => Reading.cases.Closed.make({}),
    )
  })
  return { ...atoms, reading, edit: Events.Edit, close: Events.Close, save: Events.Save }
}

/** Whether this document's editor is up, rather than its text being read. */
export const isEditing = (reading: Reading, id: ArtifactId) =>
  Reading.match(reading, {
    Starting: () => false,
    Closed: () => false,
    Editing: (editing) => editing.id === id,
    Saving: (saving) => saving.id === id,
    Changed: (changed) => changed.id === id,
    Refused: (refused) => refused.id === id,
  })

/** Whether the editor is waiting on the server: its Save is disabled and the machine refuses one. */
export const isWaiting = Reading.isAnyOf(['Starting', 'Saving'])

/** What the editor says above its field, from the machine alone. */
export const noticeOf = (reading: Reading): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Closed: () => Option.none(),
    Editing: () => Option.none(),
    Saving: () => Option.none(),
    Changed: ({ newest }) =>
      Option.some(
        `This document changed while you were editing (now version ${newest}). Save to replace it with your text, or close to keep it.`,
      ),
    Refused: () => Option.some('Your changes were not saved. Try again.'),
  })

/** The text the editor starts with when it opens again after a refusal, so nothing typed is lost. */
export const keptText = (reading: Reading): Option.Option<string> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Closed: () => Option.none(),
    Editing: () => Option.none(),
    Saving: ({ body }) => Option.some(body),
    Changed: ({ body }) => Option.some(body),
    Refused: ({ body }) => Option.some(body),
  })

const decodeBody = Schema.decodeUnknownOption(ArtifactBody)

/** What was typed, as a body the server will take: not empty, and within its length. */
export const typedBody = (typed: string): Option.Option<typeof ArtifactBody.Type> =>
  typed.trim().length === 0 ? Option.none() : decodeBody(typed)
