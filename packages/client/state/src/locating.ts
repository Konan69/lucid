import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import type { LocationReading } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Predicate, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import type { ProductFailure } from './live.js'

/**
 * Sharing where the Person is (`packages/contracts/src/location.ts`), as one machine for every
 * surface: the switch in Settings turns it on or off.
 *
 * Whether it is on is the server's (`Settings.location`), read as a live query; this machine is
 * only the press and what it waits on. Turning on asks the device first, so the system's question
 * appears only when the Person turned sharing on and never at sign-in, then tells the server, then
 * sends where the device is at once so Vivid has a place before the next message. Turning off
 * tells the server, which forgets the last reading in the same write.
 *
 * Every press carries its attempt and every outcome says which attempt it answers, because a
 * state can be entered again and the library can deliver an outcome queued for the earlier entry
 * (`.agents/skills/state-machines` "Re-entered states check every invoke outcome").
 */

/** Names one press. The presser makes it; every outcome of its work says it back. */
export const AttemptId = Schema.String.pipe(Schema.brand('LocatingAttemptId'))
export type AttemptId = typeof AttemptId.Type

/**
 * Why a press did not finish, each said differently: the Person refused the device's question
 * (`Blocked`, which only the system's own settings undo), closed it unanswered (`Dismissed`), the
 * device could not say where it is (`Unavailable`), or the server was not reached (`Unreachable`).
 */
export const Reason = Schema.Literals(['Blocked', 'Dismissed', 'Unavailable', 'Unreachable'])
export type Reason = typeof Reason.Type

export class Refused extends Schema.TaggedError<Refused>()(
  'LocatingRefused',
  { reason: Reason },
  { title: 'LocatingRefused' },
) {}

/** The refusal for a call the live engine answered with this failure: transport or answer. */
export const serverRefused = (failure: ProductFailure) =>
  new Refused({
    reason: Predicate.isTagged(failure, 'RpcClientError') ? 'Unreachable' : 'Unavailable',
  })

/** What a device does; see `Device`. */
export interface DeviceService {
  /** Asks the Person for this device's location when they have not answered yet. */
  readonly allow: Effect.Effect<void, Refused>
  /** Where the device is now, coarsely. It asks nothing, and fails while it is not allowed. */
  readonly read: Effect.Effect<LocationReading, Refused>
}

/** This device's side: a browser's geolocation, or a phone's permission and location service. */
export class Device extends Context.Service<Device, DeviceService>()(
  '@vivid/state/locating/Device',
) {}

/** What the server is asked; see `Server`. */
export interface ServerService {
  readonly turn: (on: boolean) => Effect.Effect<void, Refused>
  readonly share: (reading: LocationReading) => Effect.Effect<void, Refused>
}

/** The server's side, over the app's own connection: `PatchSettings` and `ShareLocation`. */
export class Server extends Context.Service<Server, ServerService>()(
  '@vivid/state/locating/Server',
) {}

/**
 * Sends where the device is now, right after sharing is turned on, so Vivid has a place before
 * the next message. It asks the Person nothing. The apps send at their own moments (coming to the
 * front, a message sent) with the same two services, while the Person's Settings say it is on.
 */
const share = Effect.fn('Locating.share')(function* () {
  const reading = yield* Device.use((device) => device.read)
  yield* Server.use((server) => server.share(reading))
})

/** A queued failure belongs to the attempt that started the work, even after re-entry. */
class AttemptFailed extends Schema.TaggedError<AttemptFailed>()(
  'LocatingAttemptFailed',
  { attempt: AttemptId, reason: Reason },
  { title: 'LocatingAttemptFailed' },
) {}

const failed = (attempt: AttemptId) => (error: Refused) =>
  new AttemptFailed({ attempt, reason: error.reason })

/**
 * - `Ready`: nothing waits; the switch shows what the server says.
 * - `TurningOn`: the device is asked, then the server is told.
 * - `TurningOff`: the server is told.
 * - `Refused`: the last press did not finish, for `reason`, said beside the switch until the next.
 */
const States = Machine.state({
  states: {
    Ready: {},
    TurningOn: { fields: { attempt: AttemptId } },
    TurningOff: { fields: { attempt: AttemptId } },
    Refused: { fields: { reason: Reason } },
  },
})

const Events = Machine.events({
  TurnOn: { attempt: AttemptId },
  TurnOff: { attempt: AttemptId },
})

const pressed = ({ event }: { readonly event: { readonly attempt: AttemptId } }) => ({
  attempt: event.attempt,
})
const turningOn = { target: 'TurningOn', data: pressed } as const
const turningOff = { target: 'TurningOff', data: pressed } as const

const machine = Machine.make({
  id: 'Locating',
  root: States,
  events: Events,
  effects: {
    // A place that cannot be read right after turning on is not a refusal: sharing is on, and the
    // next time the app comes to the front sends one.
    on: (attempt: AttemptId) =>
      Device.use((device) => device.allow).pipe(
        Effect.andThen(Server.use((server) => server.turn(true))),
        Effect.andThen(Effect.ignore(share())),
        Effect.as(attempt),
        Effect.mapError(failed(attempt)),
      ),
    off: (attempt: AttemptId) =>
      Server.use((server) => server.turn(false)).pipe(
        Effect.as(attempt),
        Effect.mapError(failed(attempt)),
      ),
  },
  branches: {
    done: { ready: { target: 'Ready' } },
    refused: { refused: { target: 'Refused' } },
  },
}).handle({
  initial: { target: 'Ready' },
  states: {
    Ready: { on: { TurnOn: turningOn, TurnOff: turningOff } },
    TurningOn: {
      invoke: {
        src: 'on',
        input: ({ state }) => state.attempt,
        onDone: {
          branches: 'done',
          declinable: true,
          resolve: (context) =>
            context.output === context.state.attempt ? context.select.ready() : context.decline(),
        },
        onFailure: {
          branches: 'refused',
          declinable: true,
          resolve: (context) =>
            context.error.attempt === context.state.attempt
              ? context.select.refused({ data: { reason: context.error.reason } })
              : context.decline(),
        },
      },
    },
    TurningOff: {
      invoke: {
        src: 'off',
        input: ({ state }) => state.attempt,
        onDone: {
          branches: 'done',
          declinable: true,
          resolve: (context) =>
            context.output === context.state.attempt ? context.select.ready() : context.decline(),
        },
        onFailure: {
          branches: 'refused',
          declinable: true,
          resolve: (context) =>
            context.error.attempt === context.state.attempt
              ? context.select.refused({ data: { reason: context.error.reason } })
              : context.decline(),
        },
      },
    },
    Refused: { on: { TurnOn: turningOn, TurnOff: turningOff } },
  },
})

/** The screens' exhaustive reading, including startup before the machine takes a press. */
export const Reading = Schema.TaggedUnion({
  Starting: {},
  Ready: {},
  TurningOn: {},
  TurningOff: {},
  Refused: { reason: Reason },
})
export type Reading = typeof Reading.Type

/** The session's machine: its atoms outlive the screen that pressed. */
export const make = (services: Layer.Layer<Device | Server>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading => {
    if (!AsyncResult.isSuccess(result) || result.value.status !== 'active')
      return Reading.cases.Starting.make({})
    const state = result.value.state
    return Option.getOrElse(
      Option.firstSomeOf([
        Option.map(States.get(state, 'TurningOn'), () => Reading.cases.TurningOn.make({})),
        Option.map(States.get(state, 'TurningOff'), () => Reading.cases.TurningOff.make({})),
        Option.map(States.get(state, 'Refused'), (held) => Reading.cases.Refused.make(held)),
      ]),
      () => Reading.cases.Ready.make({}),
    )
  })
  return { ...atoms, reading, turnOn: Events.TurnOn, turnOff: Events.TurnOff }
}

/** The switch is held while a press waits, and before the machine has started. */
export const isWaiting = Reading.isAnyOf(['Starting', 'TurningOn', 'TurningOff'])

/**
 * What the switch shows: the press on its way while one waits, otherwise what the server says.
 */
export const shows = (reading: Reading, shared: boolean): boolean =>
  Reading.match(reading, {
    Starting: () => shared,
    Ready: () => shared,
    TurningOn: () => true,
    TurningOff: () => false,
    Refused: () => shared,
  })

/** The line under the switch: why the last press did not finish, if it did not. */
export const refusalOf = (reading: Reading): Option.Option<Reason> =>
  Reading.guards.Refused(reading) ? Option.some(reading.reason) : Option.none()
