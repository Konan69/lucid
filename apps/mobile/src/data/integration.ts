import {
  ConnectionState,
  ServiceAuthorization,
  type Connection,
  type ConnectionAuthorization,
  type Service,
} from '@vivid/contracts'
import { connecting, whichAccount } from '@vivid/state'
import { Option } from 'effect'

/**
 * The Integrations page (`screen/settings/Integrations.tsx`): the pure readings behind its rows.
 * The rules and the words are the web screen's (`apps/web/src/screen/settings/Connections.tsx`);
 * what differs on the phone is said beside each.
 */

/**
 * What a card in a Thread was handed when Vivid had already begun adding the Integration: the
 * sign-in or the key that is left (`ConnectionAuthorization`). The card presses to pick that
 * Integration up, and the server says afresh what it needs (`screen/integration/Card.tsx`).
 */
export type Authorization = typeof ConnectionAuthorization.Type

/**
 * What a pressed row says under the service's name, from where its own attempt stands in the
 * machine (`connecting` in `@vivid/state`). `Starting` is said the moment it is pressed, so the
 * press is answered before the server is; the rest is what the server's answer came to.
 *
 * A row waiting on a key says nothing: the key form is the answer, and it is in front. An
 * attempt that did not start says only that, whatever stopped it; a page that could not be
 * opened is also said at the top of the page (`refusalSentence`). A key the service did not
 * accept is said by the service's name.
 */
export const pressedWords = (standing: connecting.Standing): Option.Option<string> =>
  connecting.Standing.match(standing, {
    Still: () => Option.none(),
    Starting: () => Option.some('Connecting…'),
    Away: () => Option.some('Finish signing in, then come back'),
    Checking: () => Option.some('Checking…'),
    Keying: () => Option.none(),
    // The live list shows the account as unfinished, with its own way to finish it.
    Unfinished: () => Option.none(),
    Connected: () => Option.some('Connected'),
    Refused: ({ refusal }) =>
      connecting.Refusal.match(refusal, {
        NotBegun: () => Option.some('Did not start. Try again'),
        Blocked: () => Option.some('Did not start. Try again'),
        Unopened: () => Option.some('Did not start. Try again'),
        Unshown: () => Option.some('Did not start. Try again'),
        // The service did not take the key. No retry is promised: the server takes no second
        // key for the account, which the list now shows as not working, with its own way out.
        Unusable: ({ serviceName }) => Option.some(`${serviceName} did not accept that.`),
      }),
  })

/** What is said of a provider's page that could not be put in front of the Person. */
const notOpened = (serviceName: string) => `${serviceName}’s sign-in page could not be opened.`

/** What a card says of a press that came to nothing before anything was begun. */
const NOT_STARTED = 'That did not start. Try again.'

/**
 * The one sentence about a provider's page that could not be opened, shown at the top of the
 * Integrations page and on the card that pressed. A server that would not begin says nothing
 * here: the row or card that was pressed says it did not start. A phone has no pop-ups to block
 * (the web's `Blocked`), so were one ever said it reads as the page not opening, which it is.
 */
export const refusalSentence = (refusal: connecting.Refusal): Option.Option<string> =>
  connecting.Refusal.match(refusal, {
    NotBegun: () => Option.none(),
    Blocked: ({ serviceName }) => Option.some(notOpened(serviceName)),
    Unopened: ({ serviceName }) => Option.some(notOpened(serviceName)),
    // A key form that could not be brought up is a press that did not start, as `NotBegun` is.
    Unshown: () => Option.none(),
    // Said on the row or card that asked, by the service's name, where the key was asked for.
    Unusable: () => Option.none(),
  })

/** What a card says about its own attempt: on its button, and in a line under it. */
export interface CardSaid {
  /** What the button says in place of the card's own way in: a wait, trying again, carrying on. */
  readonly button: Option.Option<string>
  /**
   * What the Thread is carried on with, when that is what the button does and not the attempt
   * again: the attempt ended in a way pressing again cannot mend, so Vivid is told and decides.
   */
  readonly carryOn: Option.Option<string>
  /** The line under the button. `urgent` is something that did not happen. */
  readonly line: Option.Option<{ readonly words: string; readonly urgent: boolean }>
}

/**
 * What the card in a Thread says about its own attempt: on its button while the server is asked,
 * and in a line under it otherwise. A row says all of it under the service's name
 * (`pressedWords`); a card has a button to say the first on, and room to say that Vivid goes on
 * without being told. `starting` is the card's word for its first wait ("Connecting…",
 * "Opening…"). `Connected` says nothing: the card turns to "Carry on" from the live list, and a
 * press made here carries the Thread on by itself. A sign-in the Person came back from without
 * finishing is said calmly, by the service's name, and the button offers to try again: it is
 * not a fault, people look at the page and leave.
 */
export const cardSaid = (
  standing: connecting.Standing,
  card: { readonly starting: string; readonly serviceName: string },
): CardSaid => {
  const quiet: CardSaid = { button: Option.none(), line: Option.none(), carryOn: Option.none() }
  const waits = (words: string): CardSaid => ({ ...quiet, button: Option.some(words) })
  const line = (words: string, urgent: boolean): CardSaid => ({
    ...quiet,
    line: Option.some({ words, urgent }),
  })
  return connecting.Standing.match(standing, {
    Still: () => quiet,
    Starting: () => waits(card.starting),
    Away: () => line('Finish signing in, then come back. Vivid carries on by itself.', false),
    Checking: () => waits('Checking…'),
    Keying: () => quiet,
    Unfinished: (): CardSaid => ({
      ...quiet,
      button: Option.some('Try again'),
      line: Option.some({ words: `${card.serviceName} is not signed in yet.`, urgent: false }),
    }),
    Connected: () => quiet,
    Refused: ({ refusal }) =>
      connecting.Refusal.match(refusal, {
        NotBegun: () => line(NOT_STARTED, true),
        Blocked: ({ serviceName }) => line(notOpened(serviceName), true),
        Unopened: ({ serviceName }) => line(notOpened(serviceName), true),
        Unshown: () => line(NOT_STARTED, true),
        // The service did not take the key, and the server takes no second one for the account,
        // so the card's own way in (which would pick that account up) is not offered again. Nor
        // is the Person sent to replace it in Integrations: a card that waits for this very
        // account would never be answered by another, and its Thread would be stuck. The button
        // carries the Thread on with what happened instead.
        Unusable: ({ serviceName }): CardSaid => ({
          button: Option.some('Carry on'),
          line: Option.some({ words: `${serviceName} did not accept that.`, urgent: true }),
          carryOn: Option.some(`${serviceName} did not accept that key.`),
        }),
      }),
  })
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

/** Whether a name answers to what is typed in the search, whatever its case. */
export const named = (name: string, query: string): boolean =>
  name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())

/** What a row is told about the account it draws, beyond the account itself. */
export interface RowFacts {
  /** Whether it is the only account on its service, which then needs nothing to tell it apart. */
  readonly alone: boolean
  /** The Company the account is shared with, when it is not the Person's own. */
  readonly sharedWith: Option.Option<string>
  /** Where the attempt made on this account's row stands. */
  readonly pressed: connecting.Standing
}

/**
 * The line under a connected account's service: where a press stands while one is in flight, else
 * which account it is (what the Person called it, who the service says it is), else how it
 * stands. An account that does not work says both, and one a Company shares says with whom, in
 * words: a phone has no hover to explain a small mark.
 *
 * It was the day the account was added, because every account carried the service's name as its
 * label and nothing else told two apart.
 */
export const accountLine = (connection: Connection, facts: RowFacts): string =>
  Option.match(pressedWords(facts.pressed), {
    onSome: (words) => words,
    onNone: () => {
      const which = whichAccount(connection, facts.alone)
      // An account that works and is told apart by something says only that; "Connected" is
      // then what the dot on its logo already says.
      const standing =
        ConnectionState.guards.Ready(connection.state) && Option.isSome(which)
          ? Option.none<string>()
          : Option.some(standingOf(connection).words)
      const shared = Option.map(facts.sharedWith, (company) => `Shared with ${company}`)
      return [which, standing, shared].flatMap((word) => Option.toArray(word)).join(' · ')
    },
  })

/**
 * What a catalog row says under the service's name: where a press stands, else what pressing it
 * does when the service is already connected, else how it is entered. A connected service said
 * only "Connected", and nothing told a Person that pressing it again adds one more account.
 */
export const noteOf = (
  service: Service,
  connected: boolean,
  pressed: connecting.Standing,
): Option.Option<string> => {
  const said = pressedWords(pressed)
  if (Option.isSome(said)) return said
  if (connected) {
    // One more account is offered only where a sign-in can still be begun. A service that was
    // connected before its sign-in was taken off this Vivid is not a row to press, and said
    // "Add another account" all the same.
    return Option.some(
      ServiceAuthorization.guards.SetupRequired(service.authorization)
        ? 'Connected'
        : 'Connected · Add another account',
    )
  }
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
