import {
  ACCOUNT_NAME_MAX,
  AnotherAccountMessage,
  ConnectionAuthorizationMessage,
  ConnectionOwnership,
  ConnectionState,
  type AccountName,
  type Connection,
  type ConnectionId,
  type ConnectionRequestMessage,
} from '@vivid/contracts'
import { Data, Option, Schema } from 'effect'

/**
 * The accounts a Person has on their Integrations, as every client reads them.
 *
 * One service can be connected several times: two Gmail accounts are two Connections. The web app
 * and the phone app draw them differently, but which accounts belong together, what each is
 * called, when a Person is awaited to name one and which account a card in a Thread is waiting for
 * are the same everywhere, so they are decided here once.
 */

/** One connected service and every account this Person can see on it. */
export interface ServiceAccounts {
  readonly service: Connection['service']
  readonly serviceName: string
  /** The service's icon address, from the first account that carries one. */
  readonly mark: Connection['mark']
  /** The Person's own accounts first, then the Company's; each in the server's order. */
  readonly accounts: ReadonlyArray<Connection>
}

/** Oldest first, the order accounts are numbered in ("Gmail", "Gmail (2)"). */
const byAge = (accounts: ReadonlyArray<Connection>) =>
  accounts.toSorted((one, other) => one.createdAt - other.createdAt)

/**
 * Groups a list of Connections by service.
 *
 * A service stands where its first account put it: services are ordered by the day their oldest
 * account was added, newest first, so a service does not move when a second account is added to
 * it, and a newly connected service appears at the top. Inside a service the Person's own accounts
 * lead and the Company's follow, each oldest first, so a new account is added at the end of its
 * list and the rows above it stay where they were.
 */
export const byService = (
  connections: ReadonlyArray<Connection>,
): ReadonlyArray<ServiceAccounts> => {
  const groups = new Map<Connection['service'], Array<Connection>>()
  for (const connection of connections) {
    const group = groups.get(connection.service)
    if (group === undefined) groups.set(connection.service, [connection])
    else group.push(connection)
  }
  return [...groups.values()]
    .flatMap((group) => {
      const [first] = byAge(group)
      if (first === undefined) return []
      const marked = group.find((connection) => connection.mark !== null)
      return [
        {
          since: first.createdAt,
          accounts: {
            service: first.service,
            serviceName: first.serviceName,
            mark: marked === undefined ? null : marked.mark,
            accounts: [
              ...byAge(group.filter((item) => ConnectionOwnership.guards.Personal(item.ownership))),
              ...byAge(group.filter((item) => ConnectionOwnership.guards.Shared(item.ownership))),
            ],
          },
        },
      ]
    })
    .toSorted((one, other) => other.since - one.since)
    .map((group) => group.accounts)
}

/**
 * Which account a row is, in the words that tell it from the Person's others on the service:
 * what they called it, then who the service says it is ("Work · ada@example.com"), either one
 * alone, or nothing when neither is known. The service's own name is not part of it: the row
 * already sits under that name.
 */
export const accountWords = (
  connection: Pick<Connection, 'name' | 'identity'>,
): Option.Option<string> => {
  const said = [connection.name, connection.identity].filter((word) => word !== null)
  return said.length === 0 ? Option.none() : Option.some(said.join(' · '))
}

/**
 * Whether a Person is awaited to name the account they are about to add.
 *
 * Most services do not say who signed in, so a second account on one would be told apart from the
 * first by nothing but a number. The first account is never awaited about: one account needs no
 * name. A later one is awaited about only when none of the accounts already there has an identity,
 * which is the only sign a client has that this service does not give one. Where the service does
 * say (a Google account's address), the new account is named by it and the Person types nothing.
 */
export const asksName = (accounts: ReadonlyArray<Pick<Connection, 'identity'>>): boolean =>
  accounts.length > 0 && accounts.every((account) => account.identity === null)

const isAccountName = Schema.is(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))

/**
 * What a Person typed as an account's name, as it is sent: trimmed, on one line, and no longer
 * than a name may be. Nothing typed, or only spaces, is no name, which is how a name is taken
 * away again.
 */
export const typedAccountName = (written: string): Option.Option<AccountName> => {
  const name = written
    .replaceAll(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, ACCOUNT_NAME_MAX)
    .trim()
  return isAccountName(name) ? Option.some(name) : Option.none()
}

/**
 * Whether a name is already another account's on the service. The server refuses a name twice
 * among one owner's accounts (two "Work" accounts would be told apart only by a number that
 * moves), and a form says so beside its field before anything is sent. The check here is over
 * every account the Person can see on the service, their Company's included, so a Person is not
 * led into a "Work" and a "Work (2)" either. Case and the spaces around a name do not count.
 */
export const nameTaken = (
  others: ReadonlyArray<Pick<Connection, 'name'>>,
  name: Option.Option<string>,
): boolean =>
  Option.exists(name, (wanted) =>
    others.some(
      (account) =>
        account.name !== null && account.name.trim().toLowerCase() === wanted.trim().toLowerCase(),
    ),
  )

/**
 * What a card in a Thread is waiting for.
 *
 * - `Service`: Vivid offered a service. Any ready account the Person has on it answers.
 * - `Begun`: Vivid already began adding one Integration. Only that one answers.
 * - `Another`: Vivid awaited for one more account on a service the Person already connected. The
 *   accounts that were there do not answer; one begun after Vivid asked does.
 */
export type Awaited = Data.TaggedEnum<{
  Service: {}
  Begun: { readonly id: ConnectionId }
  Another: { readonly askedAt: number }
}>
export const Awaited = Data.taggedEnum<Awaited>()

const decodeBegun = Schema.decodeUnknownOption(ConnectionAuthorizationMessage)
const decodeAnother = Schema.decodeUnknownOption(AnotherAccountMessage)

/**
 * Reads what a card is waiting for from the tool result it was drawn from. The result is the
 * request message with at most one more field: what finishing an Integration takes, when Vivid
 * began one, or when Vivid awaited, when it awaited for one more account.
 */
export const awaitedOf = (output: Parameters<typeof decodeBegun>[0]): Awaited =>
  Option.match(decodeBegun(output), {
    onSome: (message): Awaited => Awaited.Begun({ id: message.authorization.connectionId }),
    onNone: () =>
      Option.match(decodeAnother(output), {
        onSome: (message): Awaited => Awaited.Another({ askedAt: message.another.askedAt }),
        onNone: (): Awaited => Awaited.Service(),
      }),
  })

/** Whether one Connection is what a card is waiting for, whatever state it is in. */
export const answers = (
  awaited: Awaited,
  request: Pick<ConnectionRequestMessage, 'service'>,
  connection: Connection,
): boolean =>
  Awaited.$match(awaited, {
    Service: () => connection.service === request.service,
    Begun: ({ id }) => connection.id === id,
    Another: ({ askedAt }) =>
      connection.service === request.service && connection.createdAt > askedAt,
  })

/** Whether what a card is waiting for is there and ready to use. */
export const answered = (
  connections: ReadonlyArray<Connection>,
  request: Pick<ConnectionRequestMessage, 'service'>,
  awaited: Awaited,
): boolean =>
  connections.some(
    (connection) =>
      ConnectionState.guards.Ready(connection.state) && answers(awaited, request, connection),
  )

/**
 * The Integration a card's press picks up instead of beginning a second one: the one Vivid began,
 * or one that was begun for this card and left unfinished. Nothing when the press begins afresh.
 */
export const begunFor = (
  connections: ReadonlyArray<Connection>,
  request: Pick<ConnectionRequestMessage, 'service'>,
  awaited: Awaited,
): Option.Option<ConnectionId> =>
  Awaited.$match(awaited, {
    Begun: ({ id }) => Option.some(id),
    Service: () => found(connections, request, awaited),
    Another: () => found(connections, request, awaited),
  })

const found = (
  connections: ReadonlyArray<Connection>,
  request: Pick<ConnectionRequestMessage, 'service'>,
  awaited: Awaited,
) =>
  Option.map(
    Option.fromUndefinedOr(connections.find((connection) => answers(awaited, request, connection))),
    (connection) => connection.id,
  )

/**
 * The account that settled a card: the newest ready one that answers it. A card that asked for
 * one more account names it when it tells Vivid to carry on, because Vivid cannot tell which of a
 * Person's accounts is the new one, and guessed wrong when it was only told that there was one.
 */
export const answering = (
  connections: ReadonlyArray<Connection>,
  request: Pick<ConnectionRequestMessage, 'service'>,
  awaited: Awaited,
): Option.Option<Connection> =>
  Option.fromUndefinedOr(
    connections
      .filter(
        (connection) =>
          ConnectionState.guards.Ready(connection.state) && answers(awaited, request, connection),
      )
      .toSorted((one, other) => other.createdAt - one.createdAt)[0],
  )

/**
 * What a card calls the thing it is waiting for: `title` where the card is headed by a name (the
 * phone), `connect` and `done` where it is headed by what is to be done (the web), and `carryOn`,
 * the sentence the card sends into the Thread once it is there. For one more account that
 * sentence names the account that was added, when the card can see which it was.
 */
export const awaitedWords = (awaited: Awaited, serviceName: string) => {
  const connected = {
    title: serviceName,
    connect: `Connect ${serviceName}`,
    done: `${serviceName} is connected`,
    carryOn: (_added: Option.Option<Connection>) => `${serviceName} is connected. Carry on.`,
  }
  return Awaited.$match(awaited, {
    Service: () => connected,
    Begun: () => connected,
    Another: () => ({
      title: `Another ${serviceName} account`,
      connect: `Add another ${serviceName} account`,
      done: `Another ${serviceName} account is connected`,
      carryOn: (added: Option.Option<Connection>) =>
        Option.match(added, {
          onNone: () => `Another ${serviceName} account is connected. Carry on.`,
          onSome: (connection) =>
            `Another ${serviceName} account is connected: ${connection.account}. Carry on.`,
        }),
    }),
  })
}

/**
 * The words that say which account a row is, on a card that already carries its service's name.
 * What the Person called it and who the service says it is come first. An account with neither
 * needs no telling apart while it is the only one on its service; among several it is called
 * what Vivid calls it ("DeepWiki (2)", `Connection.account`), so a Person can say that to Vivid.
 */
export const whichAccount = (
  connection: Pick<Connection, 'name' | 'identity' | 'account' | 'state'>,
  alone: boolean,
): Option.Option<string> =>
  Option.orElse(accountWords(connection), () =>
    // Vivid's own name for an account is for one it can use. A sign-in that was never finished
    // is no account yet, and "Gmail (3)" on it would name something that does not exist.
    alone || !ConnectionState.guards.Ready(connection.state)
      ? Option.none()
      : Option.some(connection.account),
  )
