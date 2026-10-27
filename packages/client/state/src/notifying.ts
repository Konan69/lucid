import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { PushDestination, PushTarget } from '@vivid/contracts'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'

/**
 * Notifications that reach the Person while Vivid is closed, as one machine for every surface.
 *
 * The server already sends them (`apps/server/src/push`): to a browser's push subscription and to
 * a phone's Expo token, whichever this Person registered (`RegisterPushTarget`). What a device
 * does to have such an address is its own: a browser asks for permission and subscribes its
 * service worker against the server's key, a phone asks for permission and is given a token.
 * That differs by surface and is behind `Device`; telling the server is behind `Targets`.
 *
 * The machine is the session's, mounted once the Person is signed in, because three places press
 * it and its answer outlives each of them: the row in Settings, the first message a Person sends
 * (the moment Vivid offers, once), and the launch itself. At launch the device is read without
 * asking anything; an address it already holds is registered again, which the server takes as
 * the same target (it upserts by address) and binds to this session, so notifications follow a
 * Person who signed in again on the same device.
 *
 * One attempt runs at a time: a state that waits on the device or the server takes no press. A
 * press still carries its attempt, and every outcome says which attempt it answers, because a
 * state can be entered again (turned on, refused, turned on again) and the library can deliver an
 * outcome queued for the earlier entry (`.agents/skills/state-machines` "Reject outcomes from
 * another attempt").
 */

/** Names one attempt. The presser makes it; every outcome of the attempt's work says it back. */
export const AttemptId = Schema.String.pipe(Schema.brand('NotifyingAttemptId'))
export type AttemptId = typeof AttemptId.Type

/** The attempt made by the launch itself, when the device already holds an address. */
const LAUNCH = AttemptId.make('launch')

/** What this device holds, read without asking the Person anything. */
export const Holding = Schema.TaggedUnion({
  /** This device cannot be notified while Vivid is closed (no push, or the desktop app). */
  Unsupported: {},
  /** The Person refused notifications; only the system's own settings can undo that. */
  Blocked: {},
  /** The Person has not been asked yet. */
  Unasked: {},
  /** Allowed, and no address here: never turned on on this device, or turned off. */
  Off: {},
  /** The device has its address. */
  Held: { destination: PushDestination },
})
export type Holding = typeof Holding.Type

/** Why the device could not give an address. Each is said differently. */
export const DeviceReason = Schema.Literals(['Blocked', 'Dismissed', 'Unavailable'])
export type DeviceReason = typeof DeviceReason.Type

/**
 * The device did not give an address: the Person refused (`Blocked`), closed the question without
 * answering (`Dismissed`), or the device or its push service could not make one (`Unavailable`).
 */
export class DeviceRefused extends Schema.TaggedError<DeviceRefused>()(
  'NotifyingDeviceRefused',
  { reason: DeviceReason },
  { title: 'NotifyingDeviceRefused' },
) {}

/** The server could not be reached, or refused the address. */
export class TargetsRefused extends Schema.TaggedError<TargetsRefused>()(
  'NotifyingTargetsRefused',
  {},
  { title: 'NotifyingTargetsRefused' },
) {}

/** What a device does; see `Device`. */
export interface DeviceService {
  /** What the device holds now. It asks the Person nothing. */
  readonly read: Effect.Effect<Holding, DeviceRefused>
  /** Asks the Person when they have not answered yet, then makes this device's address. */
  readonly open: Effect.Effect<PushDestination, DeviceRefused>
  /**
   * Lets go of the address here, so a later launch reads `Off` and registers nothing. When it
   * cannot, the next launch registers the address again: still on, which is what is said.
   */
  readonly close: (destination: PushDestination) => Effect.Effect<void, DeviceRefused>
}

/** This device's side: a browser's push subscription, or a phone's permission and token. */
export class Device extends Context.Service<Device, DeviceService>()(
  '@vivid/state/notifying/Device',
) {}

/** What the server is asked; see `Targets`. */
export interface TargetsService {
  readonly register: (destination: PushDestination) => Effect.Effect<PushTarget, TargetsRefused>
  readonly remove: (target: PushTarget) => Effect.Effect<void, TargetsRefused>
}

/** The server's side, over the app's own connection: `RegisterPushTarget`, `RemovePushTarget`. */
export class Targets extends Context.Service<Targets, TargetsService>()(
  '@vivid/state/notifying/Targets',
) {}

/** Why turning notifications on did not finish, said beside the row until the next press. */
export const Refusal = Schema.Literals(['Dismissed', 'Unavailable', 'Unreachable'])
export type Refusal = typeof Refusal.Type

/** A queued failure belongs to the attempt that started the work, even after re-entry. */
class AttemptFailed extends Schema.TaggedError<AttemptFailed>()(
  'NotifyingAttemptFailed',
  { attempt: AttemptId, reason: Schema.Literals(['Blocked', ...Refusal.literals]) },
  { title: 'NotifyingAttemptFailed' },
) {}

const OnFields = { destination: PushDestination, target: PushTarget }

const States = Machine.state({
  states: {
    /** The device is being read, at launch. */
    Starting: {},
    Unsupported: {},
    Blocked: {},
    Unasked: {},
    Off: {},
    /** The Person is being asked, or the device is making its address. */
    Opening: { fields: { attempt: AttemptId } },
    /** The server is being told the address. */
    Registering: { fields: { attempt: AttemptId, destination: PushDestination } },
    On: { fields: OnFields },
    /** The server is being told to forget the address, then the device lets go of it. */
    Closing: { fields: { attempt: AttemptId, ...OnFields } },
    /** Turning off did not reach the server: still on, and the Person is told so. */
    Kept: { fields: OnFields },
    /** Turning on did not finish. */
    Refused: { fields: { reason: Refusal } },
  },
})
type State = Parameters<typeof States.matches>[0]

const Events = Machine.events({
  /** The Person turned notifications on, in Settings. */
  TurnOn: { attempt: AttemptId },
  /**
   * Vivid offers them once the Person has sent a message: taken only while the Person was never
   * asked, so a refusal or a dismissal is not asked again on the next message.
   */
  Offer: { attempt: AttemptId },
  /** The Person turned notifications off, in Settings. */
  TurnOff: { attempt: AttemptId },
})

/** A press that starts turning on, from any state that is not waiting. */
const opening = {
  target: 'Opening',
  data: ({ event }: { readonly event: { readonly attempt: AttemptId } }) => ({
    attempt: event.attempt,
  }),
} as const

/** A press that starts turning off, from a state that holds a registered address. */
const closing = {
  target: 'Closing',
  data: ({
    state,
    event,
  }: {
    readonly state: { readonly destination: PushDestination; readonly target: PushTarget }
    readonly event: { readonly attempt: AttemptId }
  }) => ({ attempt: event.attempt, destination: state.destination, target: state.target }),
} as const

/** The machine's failure for one attempt, from the device's own refusal. */
const failed = (attempt: AttemptId) => (error: DeviceRefused) =>
  new AttemptFailed({ attempt, reason: error.reason })

const machine = Machine.make({
  id: 'Notifying',
  root: States,
  events: Events,
  effects: {
    read: Device.use((device) => device.read),
    open: (attempt: AttemptId) =>
      Device.use((device) => device.open).pipe(
        Effect.map((destination) => ({ attempt, destination })),
        Effect.mapError(failed(attempt)),
      ),
    register: (input: { readonly attempt: AttemptId; readonly destination: PushDestination }) =>
      Targets.use((targets) => targets.register(input.destination)).pipe(
        Effect.map((target) => ({ ...input, target })),
        Effect.mapError(() => new AttemptFailed({ attempt: input.attempt, reason: 'Unreachable' })),
      ),
    // The server forgets first: an address the device let go of while the server still sends to
    // it would be refused by the push service, but the server would keep trying it.
    close: (input: {
      readonly attempt: AttemptId
      readonly destination: PushDestination
      readonly target: PushTarget
    }) =>
      Targets.use((targets) => targets.remove(input.target)).pipe(
        Effect.andThen(Device.use((device) => device.close(input.destination))),
        Effect.as(input.attempt),
        Effect.mapError(() => new AttemptFailed({ attempt: input.attempt, reason: 'Unreachable' })),
      ),
  },
  branches: {
    /** Where what the device holds at launch leads. */
    read: {
      unsupported: { target: 'Unsupported' },
      blocked: { target: 'Blocked' },
      unasked: { target: 'Unasked' },
      off: { target: 'Off' },
      held: { target: 'Registering' },
    },
    opened: { registering: { target: 'Registering' } },
    /** A refusal the system settings must undo is a state of its own; the rest are said. */
    refused: { blocked: { target: 'Blocked' }, refused: { target: 'Refused' } },
    registered: { on: { target: 'On' } },
    closed: { off: { target: 'Off' } },
    kept: { kept: { target: 'Kept' } },
  },
}).handle({
  initial: { target: 'Starting' },
  states: {
    Starting: {
      invoke: {
        src: 'read',
        onDone: {
          branches: 'read',
          resolve: ({ output, select }) => {
            type Next = ReturnType<(typeof select)[keyof typeof select]>
            return Holding.match<Next>(output, {
              Unsupported: () => select.unsupported(),
              Blocked: () => select.blocked(),
              Unasked: () => select.unasked(),
              Off: () => select.off(),
              Held: ({ destination }) => select.held({ data: { attempt: LAUNCH, destination } }),
            })
          },
        },
        onFailure: {
          branches: 'refused',
          resolve: ({ error, select }) =>
            error.reason === 'Blocked'
              ? select.blocked()
              : select.refused({ data: { reason: error.reason } }),
        },
      },
    },
    Unsupported: {},
    Blocked: { on: { TurnOn: opening } },
    Unasked: { on: { TurnOn: opening, Offer: opening } },
    Off: { on: { TurnOn: opening } },
    Opening: {
      invoke: {
        src: 'open',
        input: ({ state }) => state.attempt,
        onDone: {
          branches: 'opened',
          declinable: true,
          resolve: (context) =>
            context.output.attempt === context.state.attempt
              ? context.select.registering({ data: context.output })
              : context.decline(),
        },
        onFailure: {
          branches: 'refused',
          declinable: true,
          resolve: ({ error, state, select, decline }) => {
            if (error.attempt !== state.attempt) return decline()
            if (error.reason === 'Blocked') return select.blocked()
            return select.refused({ data: { reason: error.reason } })
          },
        },
      },
    },
    Registering: {
      invoke: {
        src: 'register',
        input: ({ state }) => ({ attempt: state.attempt, destination: state.destination }),
        onDone: {
          branches: 'registered',
          declinable: true,
          resolve: (context) =>
            context.output.attempt === context.state.attempt
              ? context.select.on({
                  data: { destination: context.output.destination, target: context.output.target },
                })
              : context.decline(),
        },
        onFailure: {
          branches: 'refused',
          declinable: true,
          resolve: (context) =>
            context.error.attempt === context.state.attempt
              ? context.select.refused({ data: { reason: 'Unreachable' } })
              : context.decline(),
        },
      },
    },
    On: { on: { TurnOff: closing } },
    Closing: {
      invoke: {
        src: 'close',
        input: ({ state }) => ({
          attempt: state.attempt,
          destination: state.destination,
          target: state.target,
        }),
        onDone: {
          branches: 'closed',
          declinable: true,
          resolve: (context) =>
            context.output === context.state.attempt ? context.select.off() : context.decline(),
        },
        onFailure: {
          branches: 'kept',
          declinable: true,
          resolve: (context) =>
            context.error.attempt === context.state.attempt
              ? context.select.kept({
                  data: { destination: context.state.destination, target: context.state.target },
                })
              : context.decline(),
        },
      },
    },
    Kept: { on: { TurnOff: closing } },
    Refused: { on: { TurnOn: opening } },
  },
})

/** What every screen reads: one exhaustive reading, including the machine starting up. */
export const Reading = Schema.TaggedUnion({
  /** The machine is starting, or reading the device. */
  Starting: {},
  Unsupported: {},
  Blocked: {},
  /** Off, whether or not the Person was ever asked. */
  Off: {},
  TurningOn: {},
  On: {},
  TurningOff: {},
  /** Still on: turning off did not reach the server. */
  Kept: {},
  Refused: { reason: Refusal },
})
export type Reading = typeof Reading.Type

/** The states that hold no data, with what each reads as. */
const PLAIN = [
  ['Unsupported', Reading.cases.Unsupported.make({})],
  ['Blocked', Reading.cases.Blocked.make({})],
  ['Unasked', Reading.cases.Off.make({})],
  ['Off', Reading.cases.Off.make({})],
] as const

/** The reading of one state of the machine. */
const readingOf = (state: State): Reading =>
  Option.getOrElse(
    Option.firstSomeOf([
      ...PLAIN.map(([name, reading]) =>
        States.matches(state, name) ? Option.some<Reading>(reading) : Option.none<Reading>(),
      ),
      Option.map(States.get(state, 'Opening'), () => Reading.cases.TurningOn.make({})),
      Option.map(States.get(state, 'Registering'), () => Reading.cases.TurningOn.make({})),
      Option.map(States.get(state, 'On'), () => Reading.cases.On.make({})),
      Option.map(States.get(state, 'Closing'), () => Reading.cases.TurningOff.make({})),
      Option.map(States.get(state, 'Kept'), () => Reading.cases.Kept.make({})),
      Option.map(States.get(state, 'Refused'), ({ reason }) =>
        Reading.cases.Refused.make({ reason }),
      ),
    ]),
    () => Reading.cases.Starting.make({}),
  )

/**
 * The session's machine as atoms: `reading` to draw from, `send` to press with, and the three
 * presses. An app makes it once from its own two services and mounts `reading` when the Person is
 * signed in, which starts it: the launch reads the device then.
 */
export const make = (services: Layer.Layer<Device | Targets>) => {
  const atoms = AtomMachine.bind(Atom.runtime(services)).make(machine)
  const reading = Atom.map(atoms.snapshot, (result): Reading =>
    AsyncResult.isSuccess(result) && result.value.status === 'active'
      ? readingOf(result.value.state)
      : Reading.cases.Starting.make({}),
  )
  return {
    ...atoms,
    reading,
    turnOn: Events.TurnOn,
    offer: Events.Offer,
    turnOff: Events.TurnOff,
  }
}
export type Notifying = ReturnType<typeof make>

/** Whether the device or the server is being waited on: the row's switch is held meanwhile. */
export const isWaiting = Reading.isAnyOf(['Starting', 'TurningOn', 'TurningOff'])

/** Whether the row's switch shows on: on, on its way, or still on after a failed turn-off. */
export const isOn = Reading.isAnyOf(['TurningOn', 'On', 'Kept'])
