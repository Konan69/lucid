import { useAtom, useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  ChannelStanding,
  ConnectionOwnership,
  ConnectionState,
  ServiceAuthorization,
  ServiceCatalog,
  Workspace,
  type ChannelLink,
  type Connection,
  type MeResponse,
  type Service,
} from '@vivid/contracts'
import { channelWords, liveStateOf } from '@vivid/state'
import { Option, Result } from 'effect'
import { Building2, Search, Unplug } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  change,
  live,
  LiveState,
  services,
  serviceSearch,
  useLive,
  useLiveValue,
} from '../../data/live'
import { router } from '../../data/route'
import { orSay } from '../../data/said'
import { Button, IconButton } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Segmented } from '../../ui/Segmented'
import { Began, begin, follow } from '../integration/begin'
import { EnterKey, type Keying } from '../integration/Key'
import { Mark } from '../integration/Mark'
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

const added = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** How a Connection stands, as the colour of its dot and the words beside it. */
const STANDING = (connection: Connection) =>
  ConnectionState.match(connection.state, {
    Ready: () => ({ dot: 'bg-success', words: 'Connected' }),
    NeedsAuthorization: () => ({ dot: 'bg-approve', words: 'Sign-in not finished' }),
    Failed: ({ reason }) => ({ dot: 'bg-danger', words: `Not working: ${reason}` }),
  })

/**
 * Which account a tile is, when the service's name alone does not say: what the Person called it,
 * when they called it anything, else the day it was added, so two accounts on one service can be
 * told apart before one of them is disconnected.
 */
const WHICH = (connection: Connection) =>
  connection.label === connection.serviceName
    ? `Added ${added.format(connection.createdAt)}`
    : connection.label

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

  async function connect(service: Service) {
    // A sign-in tab is opened by the click itself, before the server is asked anything. A service
    // whose way in is known only after install may turn out to want a sign-in, so it gets the tab
    // too; `follow` closes a tab the answer does not need.
    const tab = ServiceAuthorization.isAnyOf(['SignIn', 'KnownAfterInstall'])(service.authorization)
      ? window.open('about:blank', '_blank')
      : null
    mark(service.id, Option.some('starting'))
    settle(service.id, await begin(service, tab, admin && forCompany))
  }

  /**
   * Picks a Connection up where it stopped: the sign-in tab was closed, the key was never
   * entered, or the sign-in lapsed. It is the same Connection afterwards, not a second one.
   *
   * A Connection does not say whether it wants a sign-in page or a key until it is asked, so the
   * tab is opened once the answer is a sign-in page. A browser allows that for a few seconds
   * after the click; when it has stopped allowing it, the tile says to allow pop-ups.
   */
  async function resume(connection: Connection) {
    mark(connection.id, Option.some('starting'))
    const result = await change((client) => client.ResumeConnection({ id: connection.id }))
    settle(connection.id, Result.isFailure(result) ? Began.Refused() : follow(result.success, null))
  }

  const disconnect = (connection: Connection) =>
    void orSay(
      change((client) => client.RemoveConnection({ id: connection.id })),
      `${connection.serviceName} could not be disconnected. Try again.`,
    )

  return (
    <div className="flex flex-col gap-6 pt-1">
      <Find query={query} onQuery={setQuery} />
      <Connected
        connections={connections.filter((item) => named(item.serviceName, query))}
        searching={query.trim().length > 0}
        company={Option.map(company, (workspace) => workspace.company.name)}
        admin={admin}
        presses={presses}
        onResume={(connection) => void resume(connection)}
        onDisconnect={disconnect}
      />
      <TextVivid query={query} />
      <Catalog
        connected={connections
          .filter((item) => ConnectionState.guards.Ready(item.state))
          .map((item) => item.service)}
        presses={presses}
        onConnect={(service) => void connect(service)}
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
 */
function Connected({
  connections,
  searching,
  company,
  admin,
  presses,
  onResume,
  onDisconnect,
}: {
  connections: ReadonlyArray<Connection>
  searching: boolean
  /** The Company's name, in a Company's workspace. */
  company: Option.Option<string>
  admin: boolean
  presses: Presses
  onResume: (connection: Connection) => void
  onDisconnect: (connection: Connection) => void
}) {
  if (connections.length === 0) return searching ? null : <NothingConnected />
  // The Person's own accounts first, then the Company's; each keeps the server's order.
  const mine = connections.filter((item) => ConnectionOwnership.guards.Personal(item.ownership))
  const shared = connections.filter((item) => ConnectionOwnership.guards.Shared(item.ownership))
  return (
    <section>
      <Heading title="Connected" count={connections.length} />
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {[...mine, ...shared].map((connection, place) => {
          const own = ConnectionOwnership.guards.Personal(connection.ownership)
          return (
            <ConnectedTile
              key={connection.id}
              place={place}
              connection={connection}
              sharedWith={own ? Option.none() : company}
              pressed={Option.fromUndefinedOr(presses.get(connection.id))}
              // A Company's Connection is finished or removed by an admin, never by a member.
              actions={own || admin ? Option.some({ onResume, onDisconnect }) : Option.none()}
            />
          )
        })}
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
 * One connected account as a large tile: the service's logo, its name, how it stands and which
 * account it is. A ready one offers "Disconnect" in words; an unfinished one leads with
 * "Reconnect" and keeps disconnecting as the icon beside it.
 */
function ConnectedTile({
  place,
  connection,
  sharedWith,
  pressed,
  actions,
}: {
  place: number
  connection: Connection
  /** The Company this account is shared with, when it is not the Person's own. */
  sharedWith: Option.Option<string>
  pressed: Option.Option<Pressed>
  /** Present for whoever may finish or remove this Connection. */
  actions: Option.Option<{
    readonly onResume: (connection: Connection) => void
    readonly onDisconnect: (connection: Connection) => void
  }>
}) {
  const ready = ConnectionState.guards.Ready(connection.state)
  const standing = STANDING(connection)
  const words = Option.match(pressed, {
    onNone: () => standing.words,
    onSome: (value) => PRESSED[value],
  })
  return (
    <li
      className={cn(
        'flex min-h-18 items-center gap-3 rounded-card bg-surface-3 p-3 edge',
        ENTER,
        stagger(place),
      )}
    >
      <Mark service={{ name: connection.serviceName }} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-title font-title text-ink">{connection.serviceName}</span>
          {Option.isSome(sharedWith) && (
            <span
              title={`Shared with everyone at ${sharedWith.value}`}
              className="inline-flex shrink-0 items-center text-ink-3"
            >
              <Building2 aria-label={`Shared with ${sharedWith.value}`} className="size-3.5" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-label text-ink-3" title={words}>
          <i aria-hidden className={cn('size-1.5 shrink-0 rounded-full', standing.dot)} />
          <span className="truncate">
            {words}
            {ready && Option.isNone(pressed) && ` · ${WHICH(connection)}`}
          </span>
        </div>
      </div>
      {Option.isSome(actions) && (
        <ConnectedActions
          connection={connection}
          ready={ready}
          onResume={() => actions.value.onResume(connection)}
          onDisconnect={() => actions.value.onDisconnect(connection)}
        />
      )}
    </li>
  )
}

function ConnectedActions({
  connection,
  ready,
  onResume,
  onDisconnect,
}: {
  connection: Connection
  ready: boolean
  onResume: () => void
  onDisconnect: () => void
}) {
  if (ready) {
    return (
      <Button size="sm" variant="ghost" onClick={onDisconnect}>
        Disconnect
      </Button>
    )
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant="outline" size="sm" onClick={onResume}>
        Reconnect
      </Button>
      <IconButton label={`Disconnect ${connection.serviceName}`} onClick={onDisconnect}>
        <Unplug className="size-4" />
      </IconButton>
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
          <li key={link.channel}>
            <ChannelTile link={link} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * One messaging app: its mark, its name and its standing in a word. A channel this Vivid is not
 * set up for is shown and is not a button, the way a service nobody can connect here is.
 */
function ChannelTile({ link }: { link: ChannelLink }) {
  const body = (
    <>
      <Mark service={{ name: link.channel }} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title text-ink">{link.channel}</span>
        <span className="block truncate text-meta font-meta text-ink-3">
          {channelWords(link.standing)}
        </span>
      </span>
    </>
  )
  if (ChannelStanding.guards.Unavailable(link.standing)) {
    return <div className={cn(TILE, 'cursor-default opacity-60')}>{body}</div>
  }
  return (
    <button
      type="button"
      onClick={() => router.openSettings(Option.some('texting'))}
      className={cn(
        TILE,
        'cursor-pointer outline-none hover:bg-surface-2 focus-visible:edge-primary',
        PRESS,
      )}
    >
      {body}
      {ChannelStanding.guards.Connected(link.standing) && <Done drawn={false} />}
    </button>
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
  connected,
  presses,
  onConnect,
  whose,
}: {
  /** The services this Person already has a ready Connection to. */
  connected: ReadonlyArray<Service['id']>
  presses: Presses
  onConnect: (service: Service) => void
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
                  connected={connected.includes(service.id)}
                  pressed={Option.fromUndefinedOr(presses.get(service.id))}
                  onConnect={() => onConnect(service)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** What a tile says under the service's name: where a press stands, else how it is entered. */
function noteOf(service: Service, connected: boolean, pressed: Option.Option<Pressed>) {
  if (connected) return Option.some('Connected')
  if (Option.isSome(pressed)) return Option.some(PRESSED[pressed.value])
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
 * One service in the catalog: a tile to press, a settled fact once connected, or plainly not on
 * offer. A service nobody can connect on this installation (its sign-in was never registered by
 * whoever runs this Vivid) is still shown, says so, and is not a button.
 */
function ServiceTile({
  service,
  place,
  connected,
  pressed,
  onConnect,
}: {
  service: Service
  /** Its place in a group that arrives in a stagger; none when the grid is a search's answer. */
  place: Option.Option<number>
  connected: boolean
  pressed: Option.Option<Pressed>
  onConnect: () => void
}) {
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
    </>
  )
  if (ServiceAuthorization.guards.SetupRequired(service.authorization)) {
    return <div className={cn(TILE, 'cursor-default opacity-60', arriving)}>{body}</div>
  }
  return (
    <button
      type="button"
      onClick={onConnect}
      // One press is one Connection: the tile is not pressed again while its first press is
      // still on its way to the server.
      disabled={Option.contains(pressed, 'starting')}
      aria-busy={Option.contains(pressed, 'starting')}
      aria-label={connected ? `${service.name}, connected` : `Connect ${service.name}`}
      className={cn(
        TILE,
        'cursor-pointer outline-none hover:bg-surface-2 focus-visible:edge-primary disabled:cursor-default',
        PRESS,
        arriving,
      )}
    >
      {body}
      {/* The check draws itself only on a tile this Person pressed on this visit: that is a
          thing that has just happened. One that was connected all along is simply checked. */}
      {connected && <Done drawn={Option.isSome(pressed)} />}
    </button>
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
