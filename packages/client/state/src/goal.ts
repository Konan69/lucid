import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import {
  ProjectChange,
  ProjectId,
  ProjectText,
  UpdateProjectRequest,
  type Project,
} from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/**
 * The Person setting a Project's goal or marking it done from its page, the same on web, phone
 * and desktop. Vivid records the same work from a conversation (`update_project`); this is the
 * Person's own hand on it.
 *
 * One form is up at a time, for one Project: the goal (what done means and the next step) or done
 * (what shows it). While a change is being saved the form holds it and takes no second Save, so a
 * double press sends one call; closing the form leaves `Saving`, which interrupts the call, so a
 * late answer has no form to land in. A refused save keeps the form open, saying why, for the
 * Person to look again and save. Opening the form for another Project replaces an open one.
 *
 * What is typed is not part of the machine: it is the fields' own text until Save turns it into
 * a request (`goalRequest`, `doneRequest`), and nothing waits on it.
 */

/** Which form is up: the goal and its next step, or marking the Project done. */
export const Form = Schema.Literals(['Goal', 'Done'])
export type Form = typeof Form.Type

/**
 * Why a save did not land. `Changed`: the Project moved on since the page drew it (Vivid wrote to
 * it, or it was marked done elsewhere); the page now shows what is there, and saving again sends
 * against that. `Failed`: the server could not be reached or refused for another reason.
 */
export const Reason = Schema.Literals(['Changed', 'Failed'])
export type Reason = typeof Reason.Type

export class Refused extends Schema.TaggedError<Refused>()(
  'ProjectWorkRefused',
  { reason: Reason },
  { title: 'ProjectWorkRefused' },
) {}

/** The surface owns the authenticated call and lays the answer over its live Project list. */
export interface SettingService {
  readonly update: (request: UpdateProjectRequest) => Effect.Effect<void, Refused>
}

/** Each app supplies its own connection to the server. */
export class Setting extends Context.Service<Setting, SettingService>()(
  '@vivid/state/goal/Setting',
) {}

const States = Machine.state({
  states: {
    Closed: {},
    Editing: { fields: { projectId: ProjectId, form: Form } },
    Saving: { fields: { form: Form, request: UpdateProjectRequest } },
    Refused: { fields: { projectId: ProjectId, form: Form, reason: Reason } },
  },
})
const Events = Machine.events({
  Open: { projectId: ProjectId, form: Form },
  Close: {},
  Save: { request: UpdateProjectRequest },
})
const open = {
  target: 'Editing',
  data: ({
    event,
  }: {
    readonly event: { readonly projectId: ProjectId; readonly form: Form }
  }) => ({
    projectId: event.projectId,
    form: event.form,
  }),
} as const
const close = { target: 'Closed' } as const

const machine = Machine.make({
  id: 'ProjectGoal',
  root: States,
  events: Events,
  effects: {
    update: (request: UpdateProjectRequest) => Setting.use((service) => service.update(request)),
  },
}).handle({
  initial: { target: 'Closed' },
  states: {
    Closed: { on: { Open: open } },
    Editing: {
      on: {
        Open: open,
        Close: close,
        Save: {
          target: 'Saving',
          data: ({ state, event }) => ({ form: state.form, request: event.request }),
        },
      },
    },
    Saving: {
      invoke: {
        src: 'update',
        input: ({ state }) => state.request,
        onDone: close,
        onFailure: {
          target: 'Refused',
          data: ({ state, error }) => ({
            projectId: state.request.id,
            form: state.form,
            reason: error.reason,
          }),
        },
      },
      on: { Close: close },
    },
    Refused: {
      on: {
        Open: open,
        Close: close,
        Save: {
          target: 'Saving',
          data: ({ state, event }) => ({ form: state.form, request: event.request }),
        },
      },
    },
  },
})

/** The screen's exhaustive reading, including startup before the machine accepts events. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Closed: {},
  Editing: { projectId: ProjectId, form: Form },
  Saving: { projectId: ProjectId, form: Form },
  Refused: { projectId: ProjectId, form: Form, reason: Reason },
})
export type Reading = typeof Reading.Type

/** Session-owned, so a refusal outlives the form being redrawn and every surface reads one. */
export const make = (services: Layer.Layer<Setting>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Editing'), (editing) => Reading.cases.Editing.make(editing)),
        Option.map(States.get(state, 'Saving'), (saving) =>
          Reading.cases.Saving.make({ projectId: saving.request.id, form: saving.form }),
        ),
        Option.map(States.get(state, 'Refused'), (refused) => Reading.cases.Refused.make(refused)),
      ]),
      () => Reading.cases.Closed.make({}),
    )
  })
  return { ...atoms, reading, open: Events.Open, close: Events.Close, save: Events.Save }
}

/** The form that is up for this Project, if one is. */
export const formFor = (reading: Reading, projectId: ProjectId): Option.Option<Form> =>
  Reading.match(reading, {
    Starting: () => Option.none(),
    Closed: () => Option.none(),
    Editing: (open) => (open.projectId === projectId ? Option.some(open.form) : Option.none()),
    Saving: (open) => (open.projectId === projectId ? Option.some(open.form) : Option.none()),
    Refused: (open) => (open.projectId === projectId ? Option.some(open.form) : Option.none()),
  })

/** Whether the form is waiting on the server: its Save is disabled and the machine refuses one. */
export const isWaiting = Reading.isAnyOf(['Starting', 'Saving'])

/** What the form says above its actions, from the machine alone. */
export const refusalOf = (reading: Reading): Option.Option<string> =>
  Reading.guards.Refused(reading)
    ? Option.some(
        reading.reason === 'Changed'
          ? 'This project changed while you were editing. Check what it says now and save again.'
          : 'Unable to save. Check your connection and try again.',
      )
    : Option.none()

const decodeText = Schema.decodeUnknownOption(ProjectText)

/** What was typed, as a line of Project work the server will take, once its ends are trimmed. */
export const typedText = (typed: string): Option.Option<ProjectText> => decodeText(typed.trim())

/** Setting or correcting the goal, against the revision the page shows. Reopens a done Project. */
export const goalRequest = (
  project: Project,
  objective: ProjectText,
  nextStep: ProjectText,
): UpdateProjectRequest =>
  UpdateProjectRequest.make({
    id: project.id,
    expected: project.revision,
    change: ProjectChange.cases.Define.make({ objective, nextStep }),
  })

/** Marking the Project done in the Person's words, against the revision the page shows. */
export const doneRequest = (project: Project, summary: ProjectText): UpdateProjectRequest =>
  UpdateProjectRequest.make({
    id: project.id,
    expected: project.revision,
    change: ProjectChange.cases.Confirm.make({ summary }),
  })
