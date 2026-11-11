import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { ActionOperationId, ActionReconciliation } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/**
 * A Person asking whether an action Vivid sent, and never heard back about, went through: the
 * `Check` beside "Vivid didn’t hear back…" under a Run whose outcome is `Unknown` with an `Action`
 * uncertainty, the same on web, phone and desktop. The surface calls `ReconcileAction`, which looks
 * the operation up at its Integration, read-only, and records what it found; nothing is sent.
 *
 * It is session-owned, like `removing`: one check at a time. Each press carries its own attempt id
 * and `Checking` is entered again from `Checked` and `Unreached`, so every answer says the attempt
 * it answers and is declined when that is not the current one (`owed.ts`, the 0.46 queued-outcome
 * rule).
 */

/** Names one press. The presser makes it; the answer says it back. */
export const AttemptId = Schema.String.pipe(Schema.brand('CheckingAttemptId'))
export type AttemptId = typeof AttemptId.Type

/** One press: which operation. */
const Check = Schema.Struct({ attempt: AttemptId, operationId: ActionOperationId })
export type Check = typeof Check.Type

/**
 * What the Integration's lookup said (`ActionReconciliation`, less `Unchecked`, which a check that
 * was made is not): it happened, it did not, or the Integration cannot tell.
 */
const Finding = Schema.TaggedUnion({ Applied: {}, NotApplied: {}, Inconclusive: {} })
type Finding = typeof Finding.Type

/**
 * The server's answer as a `Finding`. `Unchecked` cannot come back from a check the server made
 * (it records an answer before it returns), and if it did, nothing would be known: so it reads as
 * `Inconclusive`, which keeps the action blocked and `Check` on offer.
 */
export const findingOf = ActionReconciliation.match({
  Unchecked: () => Finding.cases.Inconclusive.make({}),
  Applied: () => Finding.cases.Applied.make({}),
  NotApplied: () => Finding.cases.NotApplied.make({}),
  Inconclusive: () => Finding.cases.Inconclusive.make({}),
})

/** The check could not be made (the connection, the server); nothing more is known than before. */
export class Unreached extends Schema.TaggedError<Unreached>()(
  'ActionUnchecked',
  { check: Check },
  { title: 'ActionUnchecked' },
) {}

/** The surface owns the authenticated call and turns the server's answer into a `Finding`. */
export interface CheckingService {
  readonly check: (check: Check) => Effect.Effect<Finding, Unreached>
}

export class Checker extends Context.Service<Checker, CheckingService>()(
  '@vivid/state/checking/Checker',
) {}

const States = Machine.state({
  states: {
    Idle: {},
    Checking: { fields: Check.fields },
    Checked: { fields: { operationId: ActionOperationId, finding: Finding } },
    Unreached: { fields: { operationId: ActionOperationId } },
  },
})

const Events = Machine.events({ Check: Check.fields })

const check = {
  target: 'Checking',
  data: ({ event }: { readonly event: Check }) => Check.make(event),
} as const

const machine = Machine.make({
  id: 'ActionCheck',
  root: States,
  events: Events,
  branches: { checked: { checked: { target: 'Checked' }, unreached: { target: 'Unreached' } } },
  effects: {
    check: (asked: Check) =>
      Checker.use((service) => service.check(asked)).pipe(
        Effect.map((finding) => ({ check: asked, finding })),
      ),
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: { on: { Check: check } },
    Checking: {
      invoke: {
        src: 'check',
        input: ({ state }) => Check.make(state),
        onDone: {
          branches: 'checked',
          declinable: true,
          resolve: (context) =>
            context.output.check.attempt === context.state.attempt
              ? context.select.checked({
                  data: {
                    operationId: context.output.check.operationId,
                    finding: context.output.finding,
                  },
                })
              : context.decline(),
        },
        onFailure: {
          branches: 'checked',
          declinable: true,
          resolve: (context) =>
            context.error.check.attempt === context.state.attempt
              ? context.select.unreached({ data: { operationId: context.error.check.operationId } })
              : context.decline(),
        },
      },
    },
    Checked: { on: { Check: check } },
    Unreached: { on: { Check: check } },
  },
})

/** What every surface reads: nothing asked, one operation being checked, or the last answer. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Idle: {},
  Checking: { operationId: ActionOperationId },
  Checked: { operationId: ActionOperationId, finding: Finding },
  Unreached: { operationId: ActionOperationId },
})
export type Reading = typeof Reading.Type

/** Session-owned: one for the app, read by every Thread. */
export const make = (services: Layer.Layer<Checker>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'Checking'), ({ operationId }) =>
          Reading.cases.Checking.make({ operationId }),
        ),
        Option.map(States.get(state, 'Checked'), ({ operationId, finding }) =>
          Reading.cases.Checked.make({ operationId, finding }),
        ),
        Option.map(States.get(state, 'Unreached'), ({ operationId }) =>
          Reading.cases.Unreached.make({ operationId }),
        ),
      ]),
      () => Reading.cases.Idle.make({}),
    )
  })
  return { ...atoms, reading, check: Events.Check }
}

/**
 * The line under a Run whose action was never heard back about, for one operation, and what it
 * offers to press:
 *
 * - `Unheard`: nothing found out yet; `Check`.
 * - `Checking`: a check is on its way (this one or another; one at a time), or the machine has not
 *   started; `Check` is held.
 * - `Applied`: it went through; nothing to press, it is not sent again.
 * - `NotApplied`: it did not happen; `Try again` asks for it again.
 * - `Unsure`: the Integration cannot tell, or the check could not be made; `Check` stays.
 */
export const Line = Schema.TaggedUnion({
  Unheard: {},
  Checking: {},
  Applied: {},
  NotApplied: {},
  Unsure: {},
})
export type Line = typeof Line.Type

/** What the line says, one sentence each, on every surface. */
export const wordsOf = Line.match({
  Unheard: () => 'Vivid didn’t hear back, so the result of that action isn’t known yet.',
  Checking: () => 'Vivid didn’t hear back, so the result of that action isn’t known yet.',
  Applied: () => 'It went through.',
  NotApplied: () => 'It didn’t happen.',
  Unsure: () => 'Still can’t tell.',
})

/** The line for `operationId`: an answer about another operation says nothing about this one. */
export const lineOf = (reading: Reading, operationId: ActionOperationId): Line =>
  Reading.match(reading, {
    Starting: () => Line.cases.Checking.make({}),
    Idle: () => Line.cases.Unheard.make({}),
    Checking: () => Line.cases.Checking.make({}),
    Checked: (checked) =>
      checked.operationId === operationId
        ? Finding.match(checked.finding, {
            Applied: () => Line.cases.Applied.make({}),
            NotApplied: () => Line.cases.NotApplied.make({}),
            Inconclusive: () => Line.cases.Unsure.make({}),
          })
        : Line.cases.Unheard.make({}),
    Unreached: (unreached) =>
      unreached.operationId === operationId
        ? Line.cases.Unsure.make({})
        : Line.cases.Unheard.make({}),
  })
