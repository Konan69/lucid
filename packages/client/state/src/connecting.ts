import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import {
  AccountName,
  Connection,
  ConnectionId,
  ConnectionState,
  ConnectionStep,
  ServiceId,
} from '@vivid/contracts'
import { Clock, Context, Effect, type Layer, Option, Schema, Stream } from 'effect'
import { Atom } from 'effect/reactivity'

/**
 * Connecting an Integration, as one machine for every surface.
 *
 * A Person presses a service or an unfinished account; the server says what that account needs
 * next (`ConnectionStep`); the Person signs in on the provider's page or gives a key; the account
 * is connected. The web's Settings page, the web's card in a Thread, the phone's Integrations
 * page and the phone's card each used to keep this in their own `useState`, set after an `await`
 * (`apps/web/src/screen/thread/Cards.tsx` `connect`, `apps/web/src/screen/settings/Connections.tsx`
 * `settle`, `apps/mobile/src/screen/integration/flow.ts` `press`). Nothing stopped an older answer
 * from writing over a newer press: one row's late answer replaced another row's key form.
 *
 * Here the states are the only places an attempt can stand, each state owns exactly the data
 * that is true while it is active, and work belongs to the state that needs it: leaving `Asking`
 * interrupts the call, so its answer cannot arrive anywhere else. An event a state does not name
 * is not taken. One attempt is made at a time (the phone's rule, now the web's as well): a press
 * while the server is still being asked is not taken, which is what `canPress` is drawn from.
 *
 * What differs by surface is behind four services: how the server is asked (`Asking`, which also
 * says where the Person is signing in from), how a provider's page is put in front of the Person
 * (`SignInPage`: a browser tab on the web, the system browser on a phone), how the form for a key
 * is brought up (`KeyForm`: a route on the phone's stack; nothing on the web, which draws its
 * dialog from the state), and how a sign-in is heard to have finished while the Person is still
 * at the provider's page (`Arrivals`: the live list of accounts).
 */

/**
 * What was pressed: the service an account is being added on, or the account being picked up.
 * A row and a card show where their own attempt stands by comparing this with what they stand for.
 */
export const Pressed = Schema.Union([ServiceId, ConnectionId])
export type Pressed = typeof Pressed.Type

/** What the server is asked: begin one more account on a service, or pick one up where it stopped. */
export const Asked = Schema.TaggedUnion({
  /** `shared` is for the Person's Company; `name` is what the Person calls the account, when they said. */
  Begin: { service: ServiceId, shared: Schema.Boolean, name: Schema.Option(AccountName) },
  Resume: { id: ConnectionId },
})
export type Asked = typeof Asked.Type

/**
 * Names one attempt. Whoever presses makes it, and everything said about an attempt afterwards
 * from outside the machine (a key form's answer, a form or a note being closed) says which
 * attempt it means. Without it a form submitted for an attempt that has since been replaced
 * would finish the new one: both can be on the same account.
 */
export const AttemptId = Schema.String.pipe(Schema.brand('AttemptId'))
export type AttemptId = typeof AttemptId.Type

/**
 * One attempt, from its press to its end.
 *
 * `card` is the card in a Thread whose press this is (the tool call it stands for), when it is
 * one. It travels with the attempt so that the Thread which asked is the one carried on when the
 * attempt ends connected, and no other attempt can answer for it.
 */
const Attempt = Schema.Struct({
  id: Schema.suspend(() => AttemptId),
  pressed: Pressed,
  card: Schema.Option(Schema.String),
  /**
   * The moment the card stops being owed its carry-on, in ms since the epoch: ten minutes after
   * the press. It is a moment and not a timer so that it holds across every state the attempt
   * passes through and across a phone that slept: whatever ends the attempt says when it did,
   * and the two are compared.
   */
  owedUntil: Schema.Finite,
})
type Attempt = typeof Attempt.Type

/** The fields a service asks for when it takes a key. */
const KeyFields = ConnectionStep.cases.EnterKey.fields.fields
type KeyFields = typeof KeyFields.Type

/** Why an attempt ended without an account. Each is said differently, and retried differently. */
export const Refusal = Schema.TaggedUnion({
  /** The server did not begin it, or could not be reached. */
  NotBegun: {},
  /** The browser would not open the provider's page: pop-ups are off for this page. */
  Blocked: { serviceName: Schema.String },
  /** The address is not a page, or the system would not open it. */
  Unopened: { serviceName: Schema.String },
  /** The form for the service's key could not be brought up. */
  Unshown: { serviceName: Schema.String },
  /**
   * The service took what it was given and the account still cannot be used: a key it did not
   * accept. The server keeps such an account and takes no second key for it, so the attempt is
   * over; the list shows the account as not working, with its own way out.
   */
  Unusable: { serviceName: Schema.String },
})
export type Refusal = typeof Refusal.Type

/** The provider's page could not be put in front of the Person. */
export class PageRefused extends Schema.TaggedError<PageRefused>()(
  'PageRefused',
  {
    /** `Blocked`: a pop-up blocker stopped it. `Unopened`: not a page, or the system refused. */
    reason: Schema.Literals(['Blocked', 'Unopened']),
  },
  { title: 'PageRefused' },
) {}

/** The form for a key could not be brought up: there was nowhere to show it. */
export class FormRefused extends Schema.TaggedError<FormRefused>()(
  'FormRefused',
  {},
  { title: 'FormRefused' },
) {}

/** The server did not answer the question, or answered with a refusal. */
export class AskRefused extends Schema.TaggedError<AskRefused>()(
  'AskRefused',
  {},
  { title: 'AskRefused' },
) {}

/** How the server is asked; see `Asking`. */
export interface AskingService {
  readonly ask: (asked: Asked) => Effect.Effect<ConnectionStep, AskRefused>
}

/**
 * Asks the server what an account needs next. Each surface gives its own: it says where the
 * Person is (`SignInSurface`), and the web's also closes a tab it opened for a sign-in that the
 * answer turned out not to need.
 */
export class Asking extends Context.Service<Asking, AskingService>()(
  '@vivid/state/connecting/Asking',
) {}

/** The page a provider signs a Person in on, and the service it belongs to. */
export interface ProviderPage {
  readonly address: string
  readonly serviceName: string
}

/** How a provider's page is opened; see `SignInPage`. */
export interface SignInPageService {
  readonly open: (page: ProviderPage) => Effect.Effect<void, PageRefused>
}

/** Puts a provider's sign-in page in front of the Person. */
export class SignInPage extends Context.Service<SignInPage, SignInPageService>()(
  '@vivid/state/connecting/SignInPage',
) {}

/** What a key form is opened with: whose press asked for it, the account, and its fields. */
export interface KeyAsked {
  /** The attempt the form belongs to; its answer and its closing say this back. */
  readonly attempt: AttemptId
  readonly pressed: Pressed
  readonly id: ConnectionId
  readonly serviceName: string
  readonly fields: KeyFields
}

/** How the key form is brought up; see `KeyForm`. */
export interface KeyFormService {
  readonly show: (form: KeyAsked) => Effect.Effect<void, FormRefused>
}

/**
 * Brings up the form for a service's key. The phone opens a route for it; a surface that draws
 * the form from the `Keying` state itself does nothing here.
 */
export class KeyForm extends Context.Service<KeyForm, KeyFormService>()(
  '@vivid/state/connecting/KeyForm',
) {}

/** How an account is heard to have connected; see `Arrivals`. */
export interface ArrivalsService {
  /**
   * Says the account as the list shows it now and each time it changes; it need not end. The
   * machine alone decides what ends an attempt: only an account that can be used does.
   *
   * What the list shows at the start is said too, because a sign-in can finish while the server
   * is still being asked or the page is still opening, before `Away` begins to listen. A usable
   * reading is taken as this sign-in finishing: an account is only picked up while the list
   * shows it unfinished (that is when a screen offers it), and a new account was not there
   * before.
   */
  readonly of: (id: ConnectionId) => Stream.Stream<Connection>
}

/**
 * Hears an account connect while the Person is at the provider's page, without their coming
 * back: the web's sign-in tab finishes beside the page that began it, and the live list of
 * accounts is what says so. A surface with nothing to listen to gives a stream that says nothing.
 */
export class Arrivals extends Context.Service<Arrivals, ArrivalsService>()(
  '@vivid/state/connecting/Arrivals',
) {}

const AwayFields = { attempt: Attempt, id: ConnectionId }

export const ConnectingStates = Machine.state({
  states: {
    /** Nothing is being connected and there is nothing to say. */
    Idle: {},
    /** The server is being asked what the account needs. Nothing else can be pressed. */
    Asking: { fields: { attempt: Attempt, asked: Asked } },
    /** The provider's page is being opened. */
    Opening: {
      fields: { ...AwayFields, address: Schema.String, serviceName: Schema.String },
    },
    /** The Person is at the provider's page. */
    Away: { fields: AwayFields },
    /** The Person is back, and the server is being asked whether the sign-in went through. */
    Checking: { fields: AwayFields },
    /** The service wants a key: the form for these fields is the Person's next step. */
    Keying: {
      fields: { ...AwayFields, serviceName: Schema.String, fields: KeyFields },
    },
    /**
     * The Person came back and the sign-in is still to do. Not an error: people look at the page
     * and leave. The card says so; the account is listed as unfinished with a way to finish it.
     */
    Unfinished: { fields: AwayFields },
    /** The account is connected. */
    Connected: { fields: { attempt: Attempt, connection: Connection } },
    /** The attempt ended without an account. */
    Refused: { fields: { attempt: Attempt, refusal: Refusal } },
  },
})

/** Where the machine stands, as every reading of it takes it. */
export type ConnectingState = Parameters<typeof ConnectingStates.matches>[0]

export const ConnectingEvents = Machine.events({
  /**
   * The Person pressed a service or an unfinished account. `attempt` names the attempt this
   * begins and `at` is the moment of the press, in ms since the epoch: the machine reads no
   * clock when it decides, so the presser says both.
   */
  Press: {
    attempt: AttemptId,
    pressed: Pressed,
    card: Schema.Option(Schema.String),
    asked: Asked,
    at: Schema.Finite,
  },
  /** The Person came back to the app from the provider's page. */
  Returned: {},
  /**
   * The key form's own call was answered with this account, at this moment. An account that can
   * be used ends the attempt connected; one that cannot ends it refused.
   */
  Finished: { attempt: AttemptId, connection: Connection, at: Schema.Finite },
  /** The Person closed what this attempt was showing: the key form, or the words it left. */
  Dismissed: { attempt: AttemptId },
})

/** What an attempt tells whoever is listening when it ends. It is not kept: it is said once. */
export const ConnectingEmitted = Machine.emittedEvents({
  /** An account was connected. `card` is the card to carry on from, when one is still owed it. */
  Connected: { pressed: Pressed, card: Schema.Option(Schema.String), connection: Connection },
})

/** How long after its press a card is still owed its carry-on, in ms. */
const CARRY_ON_MS = 10 * 60_000

/** What a press says: the attempt it begins, what was pressed, for which card, what to ask, and when. */
interface Pressing {
  readonly attempt: AttemptId
  readonly pressed: Pressed
  readonly card: Option.Option<string>
  readonly asked: Asked
  readonly at: number
}

/** A press starts an attempt from any state that is not waiting on the server. */
const press = {
  target: 'Asking',
  data: ({ event }: { readonly event: Pressing }) => ({
    attempt: {
      id: event.attempt,
      pressed: event.pressed,
      card: event.card,
      owedUntil: event.at + CARRY_ON_MS,
    },
    asked: event.asked,
  }),
} as const

/** What the key form is opened with, from the server's answer that a key is wanted. */
const keying = (attempt: Attempt, step: typeof ConnectionStep.cases.EnterKey.Type) => ({
  attempt,
  id: step.connection.id,
  serviceName: step.connection.serviceName,
  fields: step.fields,
})

/**
 * The one thing said when an attempt ends in an account at the moment `at`. The card is named
 * only while it is still owed: after the deadline the account connects all the same, and the
 * Thread is not carried on behind a Person who has long since moved on.
 */
const connected = (attempt: Attempt, connection: Connection, at: number) =>
  ConnectingEmitted.Connected({
    pressed: attempt.pressed,
    card: at <= attempt.owedUntil ? attempt.card : Option.none(),
    connection,
  })

/** Whether an account can be used. Only such an account is a connection. */
const usable = (connection: Connection) => ConnectionState.guards.Ready(connection.state)

/** The refusal for an account the service took and that still cannot be used. */
const unusable = (attempt: Attempt, connection: Connection) => ({
  attempt,
  refusal: Refusal.cases.Unusable.make({ serviceName: connection.serviceName }),
})

/** What the server answered and when, as the machine's own call reports it. */
interface Answered {
  readonly step: ConnectionStep
  readonly at: number
}

/** An account the live list showed and when. */
interface Arrived {
  readonly connection: Connection
  readonly at: number
}

export const Connecting = Machine.make({
  id: 'Connecting',
  root: ConnectingStates,
  events: ConnectingEvents,
  emittedEvents: ConnectingEmitted,
  effects: {
    // The moment of the answer is read here, in the work, because a transition reads no clock.
    ask: Effect.fn('Connecting.ask')(function* (asked: Asked) {
      const step = yield* Asking.use((service) => service.ask(asked))
      const answered: Answered = { step, at: yield* Clock.currentTimeMillis }
      return answered
    }),
    open: (page: ProviderPage) => SignInPage.use((service) => service.open(page)),
    showKey: (form: KeyAsked) => KeyForm.use((service) => service.show(form)),
  },
  streams: {
    arrival: (id: ConnectionId): Stream.Stream<Arrived, never, Arrivals> =>
      Stream.unwrap(Arrivals.use((service) => Effect.succeed(service.of(id)))).pipe(
        Stream.mapEffect((connection) =>
          Effect.map(Clock.currentTimeMillis, (at) => ({ connection, at })),
        ),
      ),
  },
  branches: {
    /** Where the server's answer to a press leads. */
    answered: {
      signIn: { target: 'Opening' },
      key: { target: 'Keying' },
      connected: { target: 'Connected' },
      unusable: { target: 'Refused' },
    },
    /** Where the server's answer leads once the Person is back from the provider's page. */
    checked: {
      unfinished: { target: 'Unfinished' },
      key: { target: 'Keying' },
      connected: { target: 'Connected' },
      unusable: { target: 'Refused' },
    },
    /** Where an account reported from outside the machine's own calls leads. */
    finished: {
      connected: { target: 'Connected' },
      unusable: { target: 'Refused' },
    },
    dismissed: { idle: { target: 'Idle' } },
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: { on: { Press: press } },
    Asking: {
      invoke: {
        src: 'ask',
        input: ({ state }) => state.asked,
        onDone: {
          branches: 'answered',
          resolve: ({ output, state, select }, enqueue) => {
            // Each branch answers with its own selector, so the answer's type is said: `match`
            // would otherwise take the first branch's as the answer of them all.
            type Next = ReturnType<(typeof select)[keyof typeof select]>
            return ConnectionStep.match<Next>(output.step, {
              OpenSignIn: ({ connection, address }) =>
                select.signIn({
                  data: {
                    attempt: state.attempt,
                    id: connection.id,
                    address,
                    serviceName: connection.serviceName,
                  },
                }),
              EnterKey: (step) => select.key({ data: keying(state.attempt, step) }),
              Done: ({ connection }) => {
                if (!usable(connection)) {
                  return select.unusable({ data: unusable(state.attempt, connection) })
                }
                enqueue.emit(connected(state.attempt, connection, output.at))
                return select.connected({ data: { attempt: state.attempt, connection } })
              },
            })
          },
        },
        onFailure: {
          target: 'Refused',
          data: ({ state }) => ({
            attempt: state.attempt,
            refusal: Refusal.cases.NotBegun.make({}),
          }),
        },
      },
    },
    Opening: {
      invoke: {
        src: 'open',
        input: ({ state }) => ({ address: state.address, serviceName: state.serviceName }),
        onDone: {
          target: 'Away',
          data: ({ state }) => ({ attempt: state.attempt, id: state.id }),
        },
        onFailure: {
          target: 'Refused',
          data: ({ state, error }) => ({
            attempt: state.attempt,
            refusal: Refusal.cases[error.reason].make({ serviceName: state.serviceName }),
          }),
        },
      },
      // A phone can be back in front before the call that opened the browser has answered. The
      // return is taken here too, or it would be missed and the row would wait for the next one.
      on: {
        Returned: {
          target: 'Checking',
          data: ({ state }) => ({ attempt: state.attempt, id: state.id }),
        },
      },
    },
    Away: {
      // The account connecting is heard here as well as asked about on the way back: whichever
      // comes first ends the attempt, and leaving this state stops the listening.
      invoke: {
        src: 'arrival',
        input: ({ state }) => state.id,
        onElement: {
          branches: 'finished',
          declinable: true,
          resolve: (context, enqueue) => {
            const { element, state, select } = context
            // The list says the account whenever it changes; only one that can be used ends
            // the sign-in. Anything else is the sign-in still under way.
            if (!usable(element.connection)) return context.decline()
            enqueue.emit(connected(state.attempt, element.connection, element.at))
            return select.connected({
              data: { attempt: state.attempt, connection: element.connection },
            })
          },
        },
        onDone: { none: true },
      },
      on: {
        Press: press,
        Returned: {
          target: 'Checking',
          data: ({ state }) => ({ attempt: state.attempt, id: state.id }),
        },
      },
    },
    Checking: {
      invoke: {
        src: 'ask',
        input: ({ state }) => Asked.cases.Resume.make({ id: state.id }),
        onDone: {
          branches: 'checked',
          resolve: ({ output, state, select }, enqueue) => {
            type Next = ReturnType<(typeof select)[keyof typeof select]>
            return ConnectionStep.match<Next>(output.step, {
              // Still to do is not an error: people look at the page and leave.
              OpenSignIn: () =>
                select.unfinished({ data: { attempt: state.attempt, id: state.id } }),
              EnterKey: (step) => select.key({ data: keying(state.attempt, step) }),
              Done: ({ connection }) => {
                if (!usable(connection)) {
                  return select.unusable({ data: unusable(state.attempt, connection) })
                }
                enqueue.emit(connected(state.attempt, connection, output.at))
                return select.connected({ data: { attempt: state.attempt, connection } })
              },
            })
          },
        },
        // The server would not say. The list still shows the account as unfinished, with a way
        // to finish it, so the attempt ends there too.
        onFailure: {
          target: 'Unfinished',
          data: ({ state }) => ({ attempt: state.attempt, id: state.id }),
        },
      },
    },
    Keying: {
      // The form is this state's own work: it is brought up on the way in. Closing it is the
      // Person's (`Dismissed`) or its answer arriving (`Finished`), never this call ending.
      invoke: {
        src: 'showKey',
        input: ({ state }) => ({
          attempt: state.attempt.id,
          pressed: state.attempt.pressed,
          id: state.id,
          serviceName: state.serviceName,
          fields: state.fields,
        }),
        onDone: { none: true },
        onFailure: {
          target: 'Refused',
          data: ({ state }) => ({
            attempt: state.attempt,
            refusal: Refusal.cases.Unshown.make({ serviceName: state.serviceName }),
          }),
        },
      },
      on: {
        Press: press,
        Dismissed: {
          // Closing what an attempt shows ends it only when it is that attempt being closed.
          branches: 'dismissed',
          declinable: true,
          resolve: (context) =>
            context.event.attempt === context.state.attempt.id
              ? context.select.idle()
              : context.decline(),
        },
        Finished: {
          branches: 'finished',
          declinable: true,
          resolve: (context, enqueue) => {
            const { event, state, select } = context
            // Only this attempt's own form, about this attempt's own account: a form left
            // from an attempt that was replaced answers late, and may name the same account.
            const own = event.attempt === state.attempt.id && event.connection.id === state.id
            if (!own) return context.decline()
            if (!usable(event.connection)) {
              return select.unusable({ data: unusable(state.attempt, event.connection) })
            }
            enqueue.emit(connected(state.attempt, event.connection, event.at))
            return select.connected({
              data: { attempt: state.attempt, connection: event.connection },
            })
          },
        },
      },
    },
    Unfinished: {
      on: {
        Press: press,
        Dismissed: {
          // Closing what an attempt shows ends it only when it is that attempt being closed.
          branches: 'dismissed',
          declinable: true,
          resolve: (context) =>
            context.event.attempt === context.state.attempt.id
              ? context.select.idle()
              : context.decline(),
        },
      },
    },
    Connected: {
      on: {
        Press: press,
        Dismissed: {
          // Closing what an attempt shows ends it only when it is that attempt being closed.
          branches: 'dismissed',
          declinable: true,
          resolve: (context) =>
            context.event.attempt === context.state.attempt.id
              ? context.select.idle()
              : context.decline(),
        },
      },
    },
    Refused: {
      on: {
        Press: press,
        Dismissed: {
          // Closing what an attempt shows ends it only when it is that attempt being closed.
          branches: 'dismissed',
          declinable: true,
          resolve: (context) =>
            context.event.attempt === context.state.attempt.id
              ? context.select.idle()
              : context.decline(),
        },
      },
    },
  },
})

/**
 * Where the attempt made on one row or card stands, for that row or card to say. An attempt made
 * on anything else is `Still` here: only what was pressed speaks.
 */
export const Standing = Schema.TaggedUnion({
  /** No attempt of this row's is under way and none has left anything to say. */
  Still: {},
  /** The server is being asked, or the provider's page is being opened. */
  Starting: {},
  /** The Person is at the provider's page. */
  Away: {},
  /** They are back and the server is being asked whether it went through. */
  Checking: {},
  /** The service wants a key. */
  Keying: {
    attempt: AttemptId,
    id: ConnectionId,
    serviceName: Schema.String,
    fields: KeyFields,
  },
  /** They came back and the sign-in is still to do. */
  Unfinished: {},
  Connected: { connection: Connection },
  Refused: { refusal: Refusal },
})
export type Standing = typeof Standing.Type

/** An attempt with how it stands. */
type Active = readonly [Attempt, Standing]

/** The attempt and its standing in whichever state is active, when one is. */
const active = (state: ConnectingState): Option.Option<Active> =>
  Option.firstSomeOf([
    Option.map(ConnectingStates.get(state, 'Asking'), (at): Active => [
      at.attempt,
      Standing.cases.Starting.make({}),
    ]),
    Option.map(ConnectingStates.get(state, 'Opening'), (at): Active => [
      at.attempt,
      Standing.cases.Starting.make({}),
    ]),
    Option.map(ConnectingStates.get(state, 'Away'), (at): Active => [
      at.attempt,
      Standing.cases.Away.make({}),
    ]),
    Option.map(ConnectingStates.get(state, 'Checking'), (at): Active => [
      at.attempt,
      Standing.cases.Checking.make({}),
    ]),
    Option.map(ConnectingStates.get(state, 'Keying'), (at): Active => [
      at.attempt,
      Standing.cases.Keying.make({
        attempt: at.attempt.id,
        id: at.id,
        serviceName: at.serviceName,
        fields: at.fields,
      }),
    ]),
    Option.map(ConnectingStates.get(state, 'Unfinished'), (at): Active => [
      at.attempt,
      Standing.cases.Unfinished.make({}),
    ]),
    Option.map(ConnectingStates.get(state, 'Connected'), (at): Active => [
      at.attempt,
      Standing.cases.Connected.make({ connection: at.connection }),
    ]),
    Option.map(ConnectingStates.get(state, 'Refused'), (at): Active => [
      at.attempt,
      Standing.cases.Refused.make({ refusal: at.refusal }),
    ]),
  ])

/**
 * The attempt the machine holds, when it holds one: what closing its words or its form names
 * (`Dismissed`).
 */
export const attemptOf = (state: ConnectingState): Option.Option<AttemptId> =>
  Option.map(active(state), ([attempt]) => attempt.id)

/** Where the attempt made on `pressed` stands. */
export const standingOf = (state: ConnectingState, pressed: Pressed): Standing =>
  Option.match(active(state), {
    onNone: () => Standing.cases.Still.make({}),
    onSome: ([attempt, standing]) =>
      attempt.pressed === pressed ? standing : Standing.cases.Still.make({}),
  })

/**
 * Where the attempt made on one card in a Thread stands, for that card to say. A card is found by
 * the tool call it stands for and not by what it pressed: a card that begins an account presses
 * its service, and from the server's first answer on the same card stands for the account that
 * was begun, so what it would press next is no longer what its attempt was pressed with. An
 * attempt made on a row, or on another card, is `Still` here.
 */
export const standingOfCard = (state: ConnectingState, card: string): Standing =>
  Option.match(active(state), {
    onNone: () => Standing.cases.Still.make({}),
    onSome: ([attempt, standing]) =>
      Option.exists(attempt.card, (pressedFrom) => pressedFrom === card)
        ? standing
        : Standing.cases.Still.make({}),
  })

/**
 * Whether the server is being waited on, anywhere: nothing can be pressed until it answers. The
 * buttons that begin an account are disabled by this, and the machine refuses the press as well.
 */
export const isWaiting = (state: ConnectingState): boolean =>
  ConnectingStates.matches(state, 'Asking') ||
  ConnectingStates.matches(state, 'Opening') ||
  ConnectingStates.matches(state, 'Checking')

/**
 * The one machine of an app, as atoms: `snapshot` to draw from, `send` to press with, and
 * `connectedBy` to hear an account connect. An app makes it once from its own three
 * services and mounts it in the registry its live data uses.
 */
export const makeConnecting = (services: Layer.Layer<Asking | SignInPage | KeyForm | Arrivals>) =>
  AtomMachine.bind(Atom.runtime(services)).make(Connecting)
export type ConnectingAtoms = ReturnType<typeof makeConnecting>

/**
 * Every account an app's machine connects, said once as it happens and never replayed: what a
 * card's carry-on listens to. It is given here so that an app needs only this module to hear it,
 * not the machine library (`AtomMachine.emissions`); it runs in the registry the machine is in.
 */
export const connectedBy = (atoms: ConnectingAtoms) => AtomMachine.emissions(atoms)
