import { useAtom, useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  ChannelStanding,
  ConnectionOwnership,
  ConnectionState,
  ServiceAuthorization,
  ServiceCatalog,
  Workspace,
  type AccountName,
  type ChannelLink,
  type Connection,
  type MeResponse,
  type Service,
} from '@vivid/contracts'
import {
  asksName,
  byService,
  channelWords,
  composerOf,
  liveStateOf,
  textLink,
  whichAccount,
  type ServiceAccounts,
} from '@vivid/state'
import { Effect, Option, Result } from 'effect'
import { Building2, Pencil, Plus, Search, Unplug } from 'lucide-react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { act } from '../../data/app'
import {
  changing,
  live,
  LiveState,
  services,
  serviceSearch,
  useLive,
  useLiveValue,
} from '../../data/live'
import { router } from '../../data/route'
import { orSay } from '../../data/said'
import { Button, buttonVariants, IconButton } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Segmented } from '../../ui/Segmented'
import { Began, begin, follow } from '../integration/begin'
import { EnterKey, type Keying } from '../integration/Key'
import { Mark } from '../integration/Mark'
import { NameAccount } from '../integration/Name'
import { byPurpose } from '../integration/purpose'
import { DRAW, ENTER, PRESS, stagger } from '../motion'
import { Awaiting } from './Parts'

/**
 * Where one tile stands after it was pressed. `starting` is said the moment it is pressed, so the
 * press is answered before the server is; the rest is what the server's answer came to.
 */
type Pressed = 'starting' | 'waiting' | 'blocked' | 'refused' | 'connected'

/** What a pressed tile says under the service's name. */
const PRESSED = {
  starting: 'Connecting…',
  waiting: 'Finish in the new tab',
  blocked: 'Allow pop-ups, then try again',
  refused: 'Did not start. Try again',
  connected: 'Connected',
} satisfies Record<Pressed, string>

/** A tile is pressed by the service it offers or by the Connection it shows. */
type Key = Service['id'] | Connection['id']
type Presses = ReadonlyMap<Key, Pressed>

/** What one press came to, as what its tile should say; nothing when it needs no words. */
const pressedOf = (began: Began): Option.Option<Pressed> =>
  Began.$match(began, {
    SigningIn: () => Option.some<Pressed>('waiting'),
    // The key dialog is the answer; the tile goes back to how it was.
    NeedsKey: () => Option.none(),
    Connected: () => Option.some<Pressed>('connected'),
    Blocked: () => Option.some<Pressed>('blocked'),
    Refused: () => Option.some<Pressed>('refused'),
  })

/** How a Connection stands, as the colour of its dot and the words beside it. */
const STANDING = (connection: Connection) =>
  ConnectionState.match(connection.state, {
    Ready: () => ({ dot: 'bg-success', words: 'Connected' }),
    NeedsAuthorization: () => ({ dot: 'bg-approve', words: 'Sign-in not finished' }),
    Failed: ({ reason }) => ({ dot: 'bg-danger', words: `Not working: ${reason}` }),
  })

/**
 * What one account's row says: which account it is, and how it stands when that is not simply
 * "working". An account that works and has something to be told apart by says only that; one
 * with nothing to tell it apart says it is connected; one that does not work says both.
 */
const rowWords = (connection: Connection, alone: boolean) => {
  const standing = STANDING(connection).words
  const which = whichAccount(connection, alone)
  if (Option.isNone(which)) return standing
  return ConnectionState.guards.Ready(connection.state)
    ? which.value
    : `${which.value} · ${standing}`
}

/** What a Person can do to the accounts on this screen; each is one call to the server. */
interface Acts {
  /** One more account on a service that is already connected, named when a name was asked for. */
  readonly onAdd: (group: ServiceAccounts, name: Option.Option<AccountName>) => void
  readonly onRename: (connection: Connection, name: Option.Option<AccountName>) => void
  readonly onResume: (connection: Connection) => void
  readonly onDisconnect: (connection: Connection) => void
}

/** Why a Person is asked for a name before one more account is added to this service. */
const whyName = (serviceName: string) =>
  `${serviceName} does not say who signs in. A name is how you and Vivid tell your accounts apart.`

const named = (name: string, query: string) =>
  name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())

/**
 * The outside services Vivid can use. Search is on top and answers for both halves of the
 * screen: what is connected, and the catalog. A Person's own Connections act only for them, in
 * every workspace; a Company's are added by an admin and can be read through by every member's
 * Vivid. What is typed here goes straight to the Connection layer and is never shown to Vivid,
 * written into a Thread, or kept in this app.
 *
 * The layout follows the reference (`refs/grok-bot-screenshots/02-what-do-you-use-every-day.png`:
 * search, then a three-column grid of tiles led by each service's real logo). It differs where
 * Vivid does: what is connected comes first with its standing, a tile connects there and then,
 * and the catalog is grouped by what a Person uses a service for.
 */
export function Connections({ me }: { me: MeResponse }) {
  const state = useLive(live.connections)
  const [query, setQuery] = useAtom(serviceSearch)
  const [presses, setPresses] = useState<Presses>(new Map())
  const [keying, setKeying] = useState<Option.Option<Keying>>(Option.none())
  const [forCompany, setForCompany] = useState(false)
  if (!LiveState.$is('Ready')(state)) return <Awaiting state={state} />
  const { connections } = state.value
  const company = Workspace.guards.Company(me.workspace) ? Option.some(me.workspace) : Option.none()
  const admin = Option.exists(company, (workspace) => workspace.role !== 'member')

  /** Keeps where one press stands beside the tile that was pressed. */
  const mark = (key: Key, pressed: Option.Option<Pressed>) =>
    setPresses((before) => {
      const after = new Map(before)
      Option.match(pressed, {
        onNone: () => after.delete(key),
        onSome: (value) => after.set(key, value),
      })
      return after
    })

  /** Says what one press came to on its tile, and opens the key dialog when a key is wanted. */
  function settle(key: Key, began: Began) {
    mark(key, pressedOf(began))
    if (Began.$is('NeedsKey')(began)) setKeying(Option.some(began.keying))
  }

  /**
   * Begins one account on a service: the first, or one more on a service that is already
   * connected. `signIn` says a sign-in may be coming, and then the tab for it is opened by the
   * click itself, before the server is asked anything; `follow` closes a tab the answer does not
   * need.
   */
  function connect(service: Service['id'], signIn: boolean, name: Option.Option<AccountName>) {
    return Effect.gen(function* () {
      const tab = signIn ? window.open('about:blank', '_blank') : null
      mark(service, Option.some('starting'))
      settle(service, yield* begin({ id: service }, tab, { shared: admin && forCompany, name }))
    })
  }

  /**
   * Picks a Connection up where it stopped: the sign-in tab was closed, the key was never
   * entered, or the sign-in lapsed. It is the same Connection afterwards, not a second one.
   *
   * A Connection does not say whether it wants a sign-in page or a key until it is asked, so the
   * tab is opened once the answer is a sign-in page. A browser allows that for a few seconds
   * after the click; when it has stopped allowing it, the tile says to allow pop-ups.
   */
  function resume(connection: Connection) {
    return Effect.gen(function* () {
      mark(connection.id, Option.some('starting'))
      const result = yield* changing((client) =>
        client.ResumeConnection({ id: connection.id, from: 'Web' }),
      )
      settle(
        connection.id,
        Result.isFailure(result) ? Began.Refused() : follow(result.success, null),
      )
    })
  }

  const disconnect = (connection: Connection) =>
    void act(
      orSay(
        changing((client) => client.RemoveConnection({ id: connection.id })),
        `${connection.serviceName} could not be disconnected. Try again.`,
      ),
    )

  /** Gives an account the Person's own name for it, or takes that name away with none. */
  const rename = (connection: Connection, name: Option.Option<AccountName>) =>
    void act(
      orSay(
        changing((client) =>
          client.RenameConnection({ id: connection.id, name: Option.getOrNull(name) }),
        ),
        'That name was not saved. Try again.',
      ),
    )

  const acts: Acts = {
    // How a connected service is entered is not on its accounts, so a sign-in is allowed for:
    // a tab the answer does not need is closed again.
    onAdd: (group, name) => void act(connect(group.service, true, name)),
    onRename: rename,
    onResume: (connection) => void act(resume(connection)),
    onDisconnect: disconnect,
  }

  return (
    <div className="flex flex-col gap-6 pt-1">
      <Find query={query} onQuery={setQuery} />
      <Connected
        connections={connections.filter((item) => named(item.serviceName, query))}
        searching={query.trim().length > 0}
        company={Option.map(company, (workspace) => workspace.company.name)}
        admin={admin}
        presses={presses}
        acts={acts}
      />
      <TextVivid query={query} />
      <Catalog
        ready={connections.filter((item) => ConnectionState.guards.Ready(item.state))}
        presses={presses}
        onConnect={(service, name) =>
          void act(
            connect(
              service.id,
              ServiceAuthorization.isAnyOf(['SignIn', 'KnownAfterInstall'])(service.authorization),
              name,
            ),
          )
        }
        whose={
          admin && Option.isSome(company) ? (
            <Segmented
              label="Who the next integration is for"
              value={forCompany ? 'company' : 'you'}
              onChange={(value) => setForCompany(value === 'company')}
              options={[
                { value: 'you', label: 'For you', name: 'For you' },
                {
                  value: 'company',
                  label: `For ${company.value.company.name}`,
                  name: `For everyone at ${company.value.company.name}`,
                },
              ]}
            />
          ) : null
        }
      />
      {Option.isSome(keying) && (
        <EnterKey keying={keying.value} onClose={() => setKeying(Option.none())} />
      )}
    </div>
  )
}

/**
 * The search, first on the screen as in the reference. It is a field, so it takes the field's
 * stronger edge and the raised fill: on the light page a field that is only a tint of the page
 * is close to invisible.
 */
function Find({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  return (
    <label className="flex h-11 cursor-text items-center gap-2.5 rounded-full bg-surface-3 px-4 edge edge-field focus-within:edge-primary">
      <Search aria-hidden className="size-4 shrink-0 text-ink-3" />
      <input
        value={query}
        onChange={(event) => onQuery(event.currentTarget.value)}
        // The catalog search takes at most this many characters; the field stops there too, so
        // a longer name is never a request the server refuses.
        maxLength={80}
        aria-label="Search integrations"
        // How many the catalog holds is never said: a number that size is noise to a Person.
        placeholder="Search integrations"
        className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
      />
    </label>
  )
}

/** A group's name over its tiles, with how many there are when that is worth saying. */
function Heading({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children?: ReactNode
}) {
  return (
    <div className="mb-2.5 flex min-h-7 items-center gap-2 px-0.5">
      <h3 className="text-label font-title text-ink">{title}</h3>
      {count !== undefined && <span className="text-label text-ink-3 tabular-nums">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  )
}

/** The services most people begin with, shown as their logos when nothing is connected yet. */
const BEGIN_WITH = ['Gmail', 'Google Calendar', 'Slack', 'Notion', 'Google Drive']

/**
 * What is connected, first on the screen. With nothing connected it is the one sentence that
 * says how connecting works, under the logos a Person is most likely looking for; while the
 * Person is searching for something else, an empty answer here is left out.
 *
 * It is one card for each service and one row in it for each account, because a Person can have
 * several accounts on one service (two Gmail accounts). It was one tile for each account, all
 * called by the service's name, and nothing on the screen said a second account could be added.
 */
function Connected({
  connections,
  searching,
  company,
  admin,
  presses,
  acts,
}: {
  connections: ReadonlyArray<Connection>
  searching: boolean
  /** The Company's name, in a Company's workspace. */
  company: Option.Option<string>
  admin: boolean
  presses: Presses
  acts: Acts
}) {
  if (connections.length === 0) return searching ? null : <NothingConnected />
  return (
    <section>
      {/* The count is of accounts that work now. A sign-in that was started and never finished is
          listed, so it can be finished or removed, but it is not counted as connected. */}
      <Heading
        title="Connected"
        count={connections.filter((item) => ConnectionState.guards.Ready(item.state)).length}
      />
      <ul className="flex flex-col gap-2.5">
        {byService(connections).map((group, place) => (
          <ServiceCard
            key={group.service}
            place={place}
            group={group}
            company={company}
            admin={admin}
            presses={presses}
            acts={acts}
          />
        ))}
      </ul>
      {Option.isSome(company) && (
        <p className="mt-2.5 px-0.5 text-meta font-meta text-pretty text-ink-3">
          Yours act only for you. Every member’s Vivid can read through {company.value}’s.
        </p>
      )}
    </section>
  )
}

function NothingConnected() {
  return (
    // One quiet band, not a panel: the logos say what this screen is for, and the catalog
    // under it is what the Person came to press, so it stays on the first screenful.
    <section className="flex flex-col items-center gap-4 rounded-card bg-surface-2 px-5 py-4 sm:flex-row">
      <div className="flex shrink-0 -space-x-2">
        {BEGIN_WITH.map((name, place) => (
          // The band's own fill rings each logo, so one reads as lying on the next.
          <span
            key={name}
            className={cn('rounded-control ring-2 ring-surface-2', ENTER, stagger(place))}
          >
            <Mark service={{ name }} size={36} />
          </span>
        ))}
      </div>
      <div className="min-w-0 text-center sm:text-left">
        <p className="text-title font-title text-ink">Nothing connected yet</p>
        <p className="text-label text-pretty text-ink-3">
          Pick what you use below. You sign in on the service’s own page, and Vivid never sees your
          password.
        </p>
      </div>
    </section>
  )
}

/**
 * One connected service: its logo and name, the way to add one more account, and every account
 * the Person can see on it. "Add account" is in words on the card itself, so a Person with one
 * Gmail account can see that a second one is possible.
 *
 * A service with one account is one line, as most are: the account is said under the service's
 * name and its actions sit at the trailing edge, so the list stays as short as it was when a
 * service could only be shown once. A service with several opens into a row for each.
 *
 * A server someone added by its address has no "Add account": adding one a second time is not
 * something the Integration layer has been shown to do (`Connection.origin`).
 */
function ServiceCard({
  place,
  group,
  company,
  admin,
  presses,
  acts,
}: {
  place: number
  group: ServiceAccounts
  company: Option.Option<string>
  admin: boolean
  presses: Presses
  acts: Acts
}) {
  const adding = Option.fromUndefinedOr(presses.get(group.service))
  /** What one account's row is told: whose it is, where a press on it stands, who may act. */
  const told = (connection: Connection) => {
    const own = ConnectionOwnership.guards.Personal(connection.ownership)
    return {
      connection,
      others: group.accounts.filter((account) => account.id !== connection.id),
      sharedWith: own ? Option.none<string>() : company,
      pressed: Option.fromUndefinedOr(presses.get(connection.id)),
      // A Company's account is named, finished or removed by an admin, never a member.
      acts: own || admin ? Option.some(acts) : Option.none<Acts>(),
    }
  }
  const [only, ...others] = group.accounts
  const add = group.accounts.some((account) => account.origin === 'Catalogue') && (
    <AddAccount
      group={group}
      // One press is one account: nothing more is begun while a press is on its way.
      busy={Option.contains(adding, 'starting')}
      onAdd={(name) => acts.onAdd(group, name)}
    />
  )
  return (
    <li className={cn('rounded-card bg-surface-3 edge', ENTER, stagger(place))}>
      {/* The line wraps: where it is too narrow for the name and the actions side by side (the
          web app on a phone), the actions drop under the name and keep to the trailing edge.
          Before this they squeezed the name down to its first letter. */}
      <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
        <Mark service={{ name: group.serviceName, mark: group.mark }} size={40} />
        <div className="min-w-40 flex-1">
          <h4 className="truncate text-title font-title text-ink">{group.serviceName}</h4>
          {Option.isSome(adding) && (
            <p role="status" className="truncate text-label text-ink-3">
              {PRESSED[adding.value]}
            </p>
          )}
          {Option.isNone(adding) && others.length > 0 && (
            <p className="truncate text-label text-ink-3">{group.accounts.length} accounts</p>
          )}
          {Option.isNone(adding) && others.length === 0 && only !== undefined && (
            <AccountWords {...told(only)} alone />
          )}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {others.length === 0 && only !== undefined && <RowActions {...told(only)} />}
          {add}
        </div>
      </div>
      {others.length > 0 && (
        // The rows start under the service's name: the card's 12, the logo's 40 and its 12.
        <ul className="flex flex-col pr-3 pb-2 pl-16">
          {group.accounts.map((connection) => (
            <li key={connection.id} className="flex min-h-9 items-center gap-2">
              <AccountWords {...told(connection)} alone={false} />
              <RowActions {...told(connection)} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The way to add one more account to a connected service: quiet words at the card's trailing
 * edge, so the one outlined button on the screen is the one an account that needs attention
 * shows ("Reconnect"). A service that says who signed in
 * (a Google account's address) is begun at once and the new account is named by that. One that
 * does not is asked a name for first, because a name is then the only thing that will tell the
 * new account from the ones already there (`asksName`).
 */
function AddAccount({
  group,
  busy,
  onAdd,
}: {
  group: ServiceAccounts
  busy: boolean
  onAdd: (name: Option.Option<AccountName>) => void
}) {
  const label = `Add another ${group.serviceName} account`
  const face = (
    <>
      <Plus />
      Add account
    </>
  )
  if (!asksName(group.accounts)) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        disabled={busy}
        onClick={() => onAdd(Option.none())}
      >
        {face}
      </Button>
    )
  }
  return (
    <NameAccount
      trigger={
        <Button variant="ghost" size="sm" aria-label={label} disabled={busy}>
          {face}
        </Button>
      }
      title="Name the new account"
      why={whyName(group.serviceName)}
      action="Add account"
      current={Option.none()}
      others={group.accounts}
      optional={false}
      onName={onAdd}
    />
  )
}

/** What a card says about one of its accounts, and what whoever manages it can do to it. */
interface Told {
  readonly connection: Connection
  /** The other accounts on its service: a name one of them has cannot be given to this one. */
  readonly others: ReadonlyArray<Connection>
  /** The Company this account is shared with, when it is not the Person's own. */
  readonly sharedWith: Option.Option<string>
  readonly pressed: Option.Option<Pressed>
  /** Present for whoever may name, finish or remove this account. */
  readonly acts: Option.Option<Acts>
}

/**
 * Which account it is and how it stands: a dot, then the words. It grows to fill its line and is
 * cut there, with the whole line as its title, so a long address is read on hover.
 */
function AccountWords({
  connection,
  sharedWith,
  pressed,
  alone,
}: Told & {
  /** Whether it is the only account on its service, which then needs nothing to tell it apart. */
  alone: boolean
}) {
  const words = Option.match(pressed, {
    onNone: () => rowWords(connection, alone),
    onSome: (value) => PRESSED[value],
  })
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label text-ink-2" title={words}>
      <i aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STANDING(connection).dot)} />
      <span className="truncate">{words}</span>
      {Option.isSome(sharedWith) && (
        <span
          title={`Shared with everyone at ${sharedWith.value}`}
          className="inline-flex shrink-0 items-center text-ink-3"
        >
          <Building2 aria-label={`Shared with ${sharedWith.value}`} className="size-3.5" />
        </span>
      )}
    </span>
  )
}

/** The account's own actions, for whoever may take them; nothing for anyone else. */
function RowActions({ connection, others, acts }: Told) {
  return Option.isSome(acts) ? (
    <AccountActions connection={connection} others={others} acts={acts.value} />
  ) : null
}

/** What whoever manages an account can do to it, at the trailing edge of its row. */
function AccountActions({
  connection,
  others,
  acts,
}: {
  connection: Connection
  others: ReadonlyArray<Connection>
  acts: Acts
}) {
  const naming = connection.name === null ? 'Name this account' : 'Rename this account'
  return (
    <div className="flex shrink-0 items-center gap-1">
      <NameAccount
        trigger={
          <IconButton size="icon-sm" label={naming}>
            <Pencil />
          </IconButton>
        }
        title={naming}
        why="Your own name for it, such as Work. Vivid uses it too. Leave it empty to remove the name."
        action="Save"
        current={Option.fromNullOr(connection.name)}
        others={others}
        optional
        onName={(name) => acts.onRename(connection, name)}
      />
      {ConnectionState.guards.Ready(connection.state) ? (
        <Button size="sm" variant="ghost" onClick={() => acts.onDisconnect(connection)}>
          Disconnect
        </Button>
      ) : (
        <>
          <Button variant="outline" size="sm" onClick={() => acts.onResume(connection)}>
            Reconnect
          </Button>
          <IconButton
            size="icon-sm"
            label={`Disconnect ${connection.serviceName}`}
            onClick={() => acts.onDisconnect(connection)}
          >
            <Unplug />
          </IconButton>
        </>
      )}
    </div>
  )
}

const GRID = 'grid grid-cols-2 gap-2.5 sm:grid-cols-3'

/** The shape every catalog tile has, pressable or not, so the grid never changes its rhythm. */
const TILE =
  'flex h-16 w-full min-w-0 items-center gap-3 rounded-card bg-surface-3 px-3 text-left edge'

/**
 * The messaging apps a Person can text Vivid from, each as a tile that says where it stands.
 *
 * They are listed here because this is where a Person looks for "connect iMessage", but they are
 * not Integrations in the catalog's sense: nothing is signed in to, and Vivid is not given an
 * account to act through. So a tile does not connect anything itself; it opens "Text Vivid" in
 * Settings, the one place the number and its code are handled. The search above filters them by
 * name like everything else on the screen.
 *
 * A connected channel takes two columns: it has a number to show whole and an action of its own,
 * and neither fits beside a mark in one.
 */
function TextVivid({ query }: { query: string }) {
  const channels = useLiveValue(live.channels)
  if (Option.isNone(channels)) return null
  const links = channels.value.channels.filter((link) => named(link.channel, query))
  if (links.length === 0) return null
  return (
    <section>
      <Heading title="Text Vivid" />
      <ul className={GRID}>
        {links.map((link) => (
          <li
            key={link.channel}
            className={cn(ChannelStanding.guards.Connected(link.standing) && 'col-span-2')}
          >
            <ChannelTile link={link} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What every channel tile shows: the app's mark, its name, and one line under it. */
function ChannelFace({ channel, line }: { channel: ChannelLink['channel']; line: string }) {
  return (
    <>
      <Mark service={{ name: channel }} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title text-ink">{channel}</span>
        {/* The whole line is also its title: a long address is cut here and read on hover. */}
        <span title={line} className="block truncate text-meta font-meta text-ink-3 tabular-nums">
          {line}
        </span>
      </span>
    </>
  )
}

/**
 * One messaging app: its mark, its name and its standing in a word. A channel this Vivid is not
 * set up for is shown and is not a button, the way a service nobody can connect here is. Any
 * other tile opens "Text Vivid" in Settings when pressed.
 *
 * It reads no live data, so each standing can be drawn without a server behind it.
 */
export function ChannelTile({ link }: { link: ChannelLink }) {
  const { channel, standing } = link
  const settings = () => router.openSettings(Option.some('texting'))
  /** The tile for a channel with nothing to text yet: all of it opens Settings. */
  const opens = (line: string) => (
    <button
      type="button"
      onClick={settings}
      className={cn(
        TILE,
        'cursor-pointer outline-none hover:bg-surface-2 focus-visible:edge-primary',
        PRESS,
      )}
    >
      <ChannelFace channel={channel} line={line} />
    </button>
  )
  return ChannelStanding.match(standing, {
    Unavailable: (unavailable) => (
      <div className={cn(TILE, 'cursor-default opacity-60')}>
        <ChannelFace channel={channel} line={channelWords(unavailable)} />
      </div>
    ),
    NotConnected: (waiting) => opens(channelWords(waiting)),
    Confirming: (confirming) => opens(channelWords(confirming)),
    Connected: ({ textTo }) => (
      <ConnectedChannelTile channel={channel} textTo={textTo} onSettings={settings} />
    ),
  })
}

/**
 * A connected channel's tile: the number to text, and "Text Vivid", which opens the messaging app
 * on a first message to it (`textLink`).
 *
 * The tile is still pressed for Settings like every other standing, so the two are siblings, not
 * one inside the other (a link inside a button is not valid, and a screen reader would read one
 * control). The Settings button is laid over the whole tile, under the link; the tile answers its
 * hover and focus. So there is one obvious action, the filled one, and the tile around it goes
 * where the tile always went.
 *
 * Where this device has nothing that opens a text (a Windows or Linux desktop, for iMessage) there
 * is no "Text Vivid": the tile keeps the tick every connected tile has, and Settings has the
 * number to copy.
 */
function ConnectedChannelTile({
  channel,
  textTo,
  onSettings,
}: {
  channel: ChannelLink['channel']
  textTo: string
  onSettings: () => void
}) {
  const link = textLink(channel, composerOf(navigator.userAgent), textTo)
  return (
    <div
      className={cn(
        TILE,
        'relative has-[>button:focus-visible]:edge-primary has-[>button:hover]:bg-surface-2',
      )}
    >
      <button
        type="button"
        aria-label={`${channel} settings`}
        onClick={onSettings}
        className="absolute inset-0 cursor-pointer rounded-card outline-none"
      />
      <ChannelFace channel={channel} line={`Connected · ${textTo}`} />
      {Option.isNone(link) && <Done drawn={false} />}
      {Option.isSome(link) && (
        <a href={link.value} className={cn(buttonVariants({ size: 'sm' }), 'relative')}>
          Text Vivid
        </a>
      )}
    </div>
  )
}

/**
 * The services Vivid can be connected to. Before anything is typed it shows the ones most people
 * want, in groups by what they are for, so the common case is one press; typing searches the
 * whole catalog by name. The server answers with its best two dozen, so the grid is never the
 * whole catalog. The last answer stays up while the next is on its way, so the grid does not
 * blink between keystrokes.
 */
function Catalog({
  ready,
  presses,
  onConnect,
  whose,
}: {
  /** The accounts this Person can use now; a service with one of them is already connected. */
  ready: ReadonlyArray<Connection>
  presses: Presses
  /** Begins an account on a service, under the name the Person gave when one was asked for. */
  onConnect: (service: Service, name: Option.Option<AccountName>) => void
  /** The admin's choice of who the next Connection is for, when there is one to make. */
  whose: ReactNode
}) {
  const query = useAtomValue(serviceSearch)
  const found = liveStateOf(useAtomValue(services))
  const again = useAtomRefresh(services)
  const searching = query.trim().length > 0
  if (LiveState.$is('Loading')(found)) {
    return (
      <section>
        <Heading title={searching ? 'Results' : 'Popular'}>{whose}</Heading>
        {/* The tiles' own shapes hold the height, so nothing jumps when they arrive. */}
        <ul className={GRID} aria-busy aria-label="Looking through the integrations">
          {['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((slot) => (
            <li key={slot} className={cn(TILE, 'opacity-50')} />
          ))}
        </ul>
      </section>
    )
  }
  if (LiveState.$is('Failed')(found) || ServiceCatalog.guards.Unavailable(found.value)) {
    return (
      <p className="rounded-card bg-surface-2 px-6 py-7 text-center text-label text-pretty text-ink-3">
        Vivid can’t reach its list of integrations right now. What you have connected still works.{' '}
        <button
          type="button"
          onClick={again}
          className="cursor-pointer rounded-xs text-ink-2 underline underline-offset-4 hover:text-ink focus-visible:text-ink"
        >
          Look again
        </button>
      </p>
    )
  }
  const { services: list } = found.value
  if (list.length === 0) {
    return (
      <p className="rounded-card bg-surface-2 px-6 py-7 text-center text-label text-ink-3">
        No integration by that name.
      </p>
    )
  }
  // A search is one answer in the catalog's order; the unsearched view is the same answer in
  // groups, so a Person looking for "something for mail" finds the shelf before the name.
  const groups = searching ? [{ purpose: 'Results', services: list }] : byPurpose(list)
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group, index) => (
        <section key={group.purpose}>
          <Heading title={group.purpose}>{index === 0 && whose}</Heading>
          <ul className={GRID}>
            {group.services.map((service, place) => (
              <li key={service.id}>
                <ServiceTile
                  service={service}
                  // Typing is a keyboard action, and a grid that re-entered on every keystroke
                  // would be noise: tiles arrive in a stagger only on the unsearched view.
                  place={searching ? Option.none() : Option.some(place)}
                  accounts={ready.filter((item) => item.service === service.id)}
                  pressed={Option.fromUndefinedOr(presses.get(service.id))}
                  onConnect={(name) => onConnect(service, name)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * What a tile says under the service's name: where a press stands, else what pressing it does
 * when the service is already connected, else how it is entered.
 *
 * A connected service said only "Connected", and nothing told a Person that pressing it again
 * adds one more account. It says so now, in the words the card above uses.
 */
function noteOf(service: Service, connected: boolean, pressed: Option.Option<Pressed>) {
  if (Option.isSome(pressed)) return Option.some(PRESSED[pressed.value])
  if (connected) {
    // One more account is offered only where a sign-in can still be begun. A service that was
    // connected before its sign-in was taken off this Vivid is not a tile to press, and said
    // "Add another account" all the same.
    return Option.some(
      ServiceAuthorization.guards.SetupRequired(service.authorization)
        ? 'Connected'
        : 'Add another account',
    )
  }
  // A catalog entry's description is written by whoever published it, often for another product
  // by name, so the tile says only what Vivid knows to be true: how the service is entered.
  return ServiceAuthorization.match(service.authorization, {
    SignIn: () => Option.none<string>(),
    Key: () => Option.some('Needs a key'),
    None: () => Option.none<string>(),
    SetupRequired: () => Option.some('Not set up on this Vivid'),
    KnownAfterInstall: () => Option.none<string>(),
  })
}

/**
 * One service in the catalog: a tile to press, or plainly not on offer. A service nobody can
 * connect on this installation (its sign-in was never registered by whoever runs this Vivid) is
 * still shown, says so, and is not a button.
 *
 * A connected service stays a tile to press: it carries the check, says "Add another account",
 * and pressing it adds one. Where the service does not say who signs in, the press first asks
 * what to call the new account, the same way "Add account" on its card does.
 */
function ServiceTile({
  service,
  place,
  accounts,
  pressed,
  onConnect,
}: {
  service: Service
  /** Its place in a group that arrives in a stagger; none when the grid is a search's answer. */
  place: Option.Option<number>
  /** The ready accounts this Person already has on the service. */
  accounts: ReadonlyArray<Connection>
  pressed: Option.Option<Pressed>
  onConnect: (name: Option.Option<AccountName>) => void
}) {
  const connected = accounts.length > 0
  const note = noteOf(service, connected, pressed)
  const arriving = Option.match(place, {
    onNone: () => '',
    onSome: (value) => cn(ENTER, stagger(value)),
  })
  const body = (
    <>
      <Mark service={service} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title text-ink">{service.name}</span>
        {Option.isSome(note) && (
          <span className="block truncate text-meta font-meta text-ink-3">{note.value}</span>
        )}
      </span>
      {/* The check draws itself only on a tile this Person pressed on this visit: that is a
          thing that has just happened. One that was connected all along is simply checked. */}
      {connected && <Done drawn={Option.isSome(pressed)} />}
    </>
  )
  if (ServiceAuthorization.guards.SetupRequired(service.authorization)) {
    return <div className={cn(TILE, 'cursor-default opacity-60', arriving)}>{body}</div>
  }
  const asks = asksName(accounts)
  const tile: ReactElement = (
    <button
      type="button"
      onClick={asks ? undefined : () => onConnect(Option.none())}
      // One press is one Connection: the tile is not pressed again while its first press is
      // still on its way to the server.
      disabled={Option.contains(pressed, 'starting')}
      aria-busy={Option.contains(pressed, 'starting')}
      aria-label={connected ? `Add another ${service.name} account` : `Connect ${service.name}`}
      className={cn(
        TILE,
        'cursor-pointer outline-none hover:bg-surface-2 focus-visible:edge-primary disabled:cursor-default aria-expanded:bg-surface-2',
        PRESS,
        arriving,
      )}
    >
      {body}
    </button>
  )
  if (!asks) return tile
  return (
    <NameAccount
      trigger={tile}
      title="Name the new account"
      why={whyName(service.name)}
      action="Add account"
      current={Option.none()}
      others={accounts}
      optional={false}
      onName={onConnect}
    />
  )
}

/** The mark of a connected service: a check on the success colour, drawn in when it is news. */
function Done({ drawn }: { drawn: boolean }) {
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-ink-on-color">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3">
        <path
          d="M3.5 8.5l3 3 6-7"
          pathLength={1}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(drawn && DRAW)}
        />
      </svg>
    </span>
  )
}
