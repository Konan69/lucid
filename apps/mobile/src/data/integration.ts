import {
  ConnectionAuthorization,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  ServiceAuthorization,
  type Connection,
  type ConnectionId,
  type ConnectionRequestMessage,
  type Service,
} from '@vivid/contracts'
import { Data, Option } from 'effect'

/**
 * Finishing an Integration Vivid started, from its card in a Thread.
 *
 * When Vivid adds an Integration from an address, the service usually still needs the Person: a
 * sign-in on the provider's own page, or a key only they have. The card's payload says which
 * (`ConnectionAuthorization`), and the server says it again, afresh, whenever it is asked
 * (`ResumeConnection` answers with a `ConnectionStep`). These are pure readings of those two; the
 * card (`screen/integration/Card.tsx`) only draws what they return.
 *
 * The rules are the web card's (`apps/web/src/screen/thread/Cards.tsx`).
 */

/** What a card was handed when Vivid had already begun adding the Integration. */
export type Authorization = typeof ConnectionAuthorization.Type

/** The fields a service asks for when it takes a key: what to send each as, and what to call it. */
export type KeyFields = (typeof ConnectionAuthorization.cases.EnterKey.Type)['fields']

/**
 * The one thing left to do to finish an Integration.
 *
 * - `SignIn`: the Person signs in on the provider's page. Where that page is, is not part of
 *   this: a sign-in address is a short-lived permission, so it is asked for at the moment it is
 *   opened (`ResumeConnection`) and never kept, on a card or here.
 * - `Key`: the Person gives the service these fields.
 * - `Done`: nothing; it is ready to use.
 */
export type Finish = Data.TaggedEnum<{
  SignIn: { readonly id: ConnectionId }
  Key: { readonly id: ConnectionId; readonly fields: KeyFields }
  Done: {}
}>
export const Finish = Data.taggedEnum<Finish>()

/** What the card's own payload says is left to do. It is never `Done`: a card is not sent for that. */
export const finishOfAuthorization = (authorization: Authorization): Finish =>
  ConnectionAuthorization.match<Finish>(authorization, {
    OpenSignIn: ({ connectionId }) => Finish.SignIn({ id: connectionId }),
    EnterKey: ({ connectionId, fields }) => Finish.Key({ id: connectionId, fields }),
  })

/** What the server says is left to do, when it is asked where the Integration stands. */
export const finishOfStep = (step: ConnectionStep): Finish =>
  ConnectionStep.match<Finish>(step, {
    OpenSignIn: ({ connection }) => Finish.SignIn({ id: connection.id }),
    EnterKey: ({ connection, fields }) => Finish.Key({ id: connection.id, fields }),
    Done: () => Finish.Done(),
  })

/**
 * What is left to do right now. What the server last said wins over the card's payload, which
 * was written when Vivid began and does not change: a sign-in finished on another device, or a
 * service that turned out to want a key, is only known by asking. A card for a service offered
 * from the catalogue carries no authorization and nothing has been asked about it, so there is
 * nothing to finish from the card.
 */
export const finishOf = (
  authorization: Option.Option<Authorization>,
  latest: Option.Option<Finish>,
): Option.Option<Finish> =>
  Option.orElse(latest, () => Option.map(authorization, finishOfAuthorization))

/**
 * Whether the Integration a card stands for can be used. The one Vivid started is that account
 * exactly, so another ready account on the same service does not finish it; a service offered
 * from the catalogue is satisfied by any ready account on it.
 */
export const isReady = (
  connections: ReadonlyArray<Connection>,
  request: ConnectionRequestMessage,
  authorization: Option.Option<Authorization>,
): boolean =>
  connections.some(
    (connection) =>
      ConnectionState.guards.Ready(connection.state) &&
      Option.match(authorization, {
        onNone: () => connection.service === request.service,
        onSome: (started) => connection.id === started.connectionId,
      }),
  )

/**
 * The Integrations sheet (`screen/settings/Integrations.tsx`): the pure readings behind its rows.
 * The rules and the words are the web screen's (`apps/web/src/screen/settings/Connections.tsx`);
 * what differs on the phone is said beside each.
 */

/**
 * Where one row stands after it was pressed. `starting` is said the moment it is pressed, so the
 * press is answered before the server is; the rest is what the server's answer came to.
 *
 * The phone has no pop-ups to block, so the web's `blocked` is not here. It has `checking`
 * instead: a phone leaves the app for the provider's page, and on the way back the server is
 * asked whether the sign-in went through.
 */
export type Pressed = 'starting' | 'waiting' | 'checking' | 'refused' | 'connected'

/** What a pressed row says under the service's name. */
export const PRESSED = {
  starting: 'Connecting…',
  waiting: 'Finish signing in, then come back',
  checking: 'Checking…',
  refused: 'Did not start. Try again',
  connected: 'Connected',
} satisfies Record<Pressed, string>

/** A row is pressed by the service it offers or by the Connection it shows. */
export type PressKey = Service['id'] | Connection['id']
export type Presses = ReadonlyMap<PressKey, Pressed>

/** The presses after one row's standing changed; a row with nothing to say is left out. */
export const afterPress = (
  before: Presses,
  key: PressKey,
  pressed: Option.Option<Pressed>,
): Presses => {
  const after = new Map(before)
  Option.match(pressed, {
    onNone: () => after.delete(key),
    onSome: (value) => after.set(key, value),
  })
  return after
}

/** The ink a standing's dot is drawn in. A word always stands beside the dot. */
export type StandingTone = 'status-success' | 'status-approve' | 'status-danger'

/** A standing as it is drawn: the colour of its dot, and the words beside it. */
interface Standing {
  readonly tone: StandingTone
  readonly words: string
}

/** How a Connection stands, as the colour of its dot and the words beside it. */
export const standingOf = (connection: Connection): Standing =>
  ConnectionState.match(connection.state, {
    Ready: (): Standing => ({ tone: 'status-success', words: 'Connected' }),
    NeedsAuthorization: (): Standing => ({ tone: 'status-approve', words: 'Sign-in not finished' }),
    Failed: ({ reason }): Standing => ({ tone: 'status-danger', words: `Not working: ${reason}` }),
  })

/**
 * Which account a row is, when the service's name alone does not say: what the Person called it,
 * when they called it anything, else the day it was added, so two accounts on one service can be
 * told apart before one of them is disconnected. The day is written by the caller's formatter.
 */
export const whichOf = (connection: Connection, added: (moment: number) => string): string =>
  connection.label === connection.serviceName
    ? `Added ${added(connection.createdAt)}`
    : connection.label

/** Whether a name answers to what is typed in the search, whatever its case. */
export const named = (name: string, query: string): boolean =>
  name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())

/** The Person's own accounts first, then the Company's; each keeps the server's order. */
export const ownFirst = (connections: ReadonlyArray<Connection>): ReadonlyArray<Connection> => [
  ...connections.filter((item) => ConnectionOwnership.guards.Personal(item.ownership)),
  ...connections.filter((item) => ConnectionOwnership.guards.Shared(item.ownership)),
]

/**
 * The line under a connected account's name: where a press stands while one is in flight, else
 * how the account stands, with which account it is once it works.
 */
export const accountLine = (
  connection: Connection,
  pressed: Option.Option<Pressed>,
  added: (moment: number) => string,
): string =>
  Option.match(pressed, {
    onSome: (value) => PRESSED[value],
    onNone: () => {
      const { words } = standingOf(connection)
      return ConnectionState.guards.Ready(connection.state)
        ? `${words} · ${whichOf(connection, added)}`
        : words
    },
  })

/** What a catalog row says under the service's name: where a press stands, else how it is entered. */
export const noteOf = (
  service: Service,
  connected: boolean,
  pressed: Option.Option<Pressed>,
): Option.Option<string> => {
  if (connected) return Option.some('Connected')
  if (Option.isSome(pressed)) return Option.some(PRESSED[pressed.value])
  // A catalog entry's description is written by whoever published it, often for another product
  // by name, so the row says only what Vivid knows to be true: how the service is entered.
  return ServiceAuthorization.match(service.authorization, {
    SignIn: () => Option.none<string>(),
    Key: () => Option.some('Needs a key'),
    None: () => Option.none<string>(),
    SetupRequired: () => Option.some('Not set up on this Vivid'),
    KnownAfterInstall: () => Option.none<string>(),
  })
}

/**
 * The icon address the catalog gives each service it answered with. A connected account from the
 * catalog carries no address of its own (`Connection.mark`: each client draws those from what it
 * bundles), and the phone bundles artwork for only a few, so its row borrows the catalog's.
 */
export const marksOf = (services: ReadonlyArray<Service>): ReadonlyMap<Service['id'], string> =>
  new Map(
    services.flatMap((service) => (service.mark === null ? [] : [[service.id, service.mark]])),
  )
