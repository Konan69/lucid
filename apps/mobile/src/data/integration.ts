import {
  ConnectionAuthorization,
  ConnectionState,
  ConnectionStep,
  type Connection,
  type ConnectionId,
  type ConnectionRequestMessage,
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
