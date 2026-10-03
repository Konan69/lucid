import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  ConnectionState,
  ServiceAuthorization,
  ServiceCatalog,
  type Connection,
  type Service,
} from '@vivid/contracts'
import { liveStateOf } from '@vivid/state'
import { Array as Arr, Option, Order } from 'effect'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { everydayServices, live, LiveState, useLiveValue } from '../../data/live'
import { router } from '../../data/route'
import { cn } from '../../ui/cn'
import { Began, begin } from '../integration/begin'
import { EnterKey, type Keying } from '../integration/Key'
import { Mark } from '../integration/Mark'

/** How many services are offered: three rows of three. Every other one is a search away. */
const SHOWN = 9

/** Where one tile stands after it was pressed, until the live list says it is connected. */
type Pressed = 'starting' | 'waiting' | 'blocked' | 'refused'

/** What a pressed tile says under the service's name. */
const PRESSED = {
  // Beginning can take the server many seconds; the tile says so from the moment it is pressed.
  starting: 'Starting…',
  waiting: 'Finish in the new tab',
  blocked: 'Allow pop-ups, then try again',
  refused: 'Did not start. Try again',
} satisfies Record<Pressed, string>

/** The colour of that line: work in progress, or something that stood in the way. */
const TONE = {
  starting: 'text-working',
  waiting: 'text-working',
  blocked: 'text-danger',
  refused: 'text-danger',
} satisfies Record<Pressed, string>

/** The Person's ready Connections, which is what makes a tile read as connected. */
export const readyOf = (connections: ReadonlyArray<Connection>) =>
  connections.filter((connection) => ConnectionState.guards.Ready(connection.state))

/**
 * The services a Person is most likely to use every day, tried in this order: mail and calendar,
 * then files, then chat. The catalog sends services by how widely they are used and says nothing
 * of what kind each is, so the few names here only move those services to the front of what the
 * catalog already returned; nothing is added that it did not send.
 */
const FIRST = ['gmail', 'google calendar', 'outlook', 'google drive', 'slack', 'notion']

/** Where a service sorts: its place in `FIRST`, or after all of those in the catalog's order. */
const placeOf = (service: Service) => {
  const place = FIRST.indexOf(service.name.trim().toLocaleLowerCase())
  return place === -1 ? FIRST.length : place
}

const byEveryday = Order.mapInput(Order.Number, placeOf)

/**
 * The services a Person uses most, each one press from connected: the grid inside Vivid's "What
 * do you use most?" card and inside the open row of the getting-started list. The pattern is
 * Grok Bot's "What do you use every day?" (a three-column grid of tiles, each a service's logo
 * in a white rounded square beside its name, `refs/grok-bot-screenshots/02-what-do-you-use-every-day.png`).
 * It differs in two ways. It sits in the conversation and not in a wizard, because Vivid speaks
 * first in the Thread and nothing blocks the app. And the reference's tiles record a choice,
 * where pressing a tile here starts the same connect flow Settings uses, at once, because a
 * browser only opens a sign-in tab inside the press that asked for it.
 *
 * A tile changes in place: "Starting…", "Finish in the new tab", then "Connected", read from the
 * live list of Connections. A service nobody can connect on this server (the server reports its
 * sign-in as not set up) is still shown, said plainly to be unavailable, and is not a button.
 */
export function Uses() {
  const found = liveStateOf(useAtomValue(everydayServices))
  const again = useAtomRefresh(everydayServices)
  const connections = useLiveValue(live.connections)
  const [pressed, setPressed] = useState<ReadonlyMap<Service['id'], Pressed>>(new Map())
  const [keying, setKeying] = useState<Option.Option<Keying>>(Option.none())
  const ready = readyOf(
    Option.match(connections, { onNone: () => [], onSome: (value) => value.connections }),
  )

  const mark = (service: Service, next: Option.Option<Pressed>) =>
    setPressed((before) => {
      const after = new Map(before)
      Option.match(next, {
        onNone: () => after.delete(service.id),
        onSome: (value) => after.set(service.id, value),
      })
      return after
    })

  async function connect(service: Service) {
    // A sign-in tab is opened by the click itself, before the server is asked anything.
    const tab = ServiceAuthorization.guards.SignIn(service.authorization)
      ? window.open('about:blank', '_blank')
      : null
    mark(service, Option.some('starting'))
    const began = await begin(service, tab, false)
    mark(
      service,
      Began.$match(began, {
        SigningIn: () => Option.some<Pressed>('waiting'),
        NeedsKey: () => Option.none(),
        Connected: () => Option.none(),
        Blocked: () => Option.some<Pressed>('blocked'),
        Refused: () => Option.some<Pressed>('refused'),
      }),
    )
    if (Began.$is('NeedsKey')(began)) setKeying(Option.some(began.keying))
  }

  return (
    <div>
      <Offered
        found={found}
        onAgain={again}
        connected={ready.map((connection) => connection.service)}
        pressed={pressed}
        onConnect={(service) => void connect(service)}
      />
      {Option.isSome(keying) && (
        <EnterKey keying={keying.value} onClose={() => setKeying(Option.none())} />
      )}
    </div>
  )
}

const GRID = 'grid grid-cols-2 gap-2 sm:grid-cols-3'

/**
 * A tile is the raised fill with an edge: on the light page a tile that is only a tint of the
 * page is close to invisible, and a tile is the thing to press.
 */
const TILE =
  'flex h-14 w-full min-w-0 items-center gap-2.5 rounded-control bg-surface-3 px-2.5 text-left edge'

/** What the catalog has to offer: the tiles, or the honest reason there are none to show. */
function Offered({
  found,
  onAgain,
  connected,
  pressed,
  onConnect,
}: {
  found: LiveState<ServiceCatalog>
  onAgain: () => void
  /** The services this Person already has a ready Connection to. */
  connected: ReadonlyArray<Service['id']>
  pressed: ReadonlyMap<Service['id'], Pressed>
  onConnect: (service: Service) => void
}) {
  if (LiveState.$is('Loading')(found)) {
    return (
      // The tiles' own shapes hold the height, so nothing jumps when they arrive.
      <ul className={GRID} aria-busy aria-label="Looking through the services">
        {['a', 'b', 'c', 'd', 'e', 'f'].map((slot) => (
          <li key={slot} className={cn(TILE, 'opacity-50')} />
        ))}
      </ul>
    )
  }
  if (LiveState.$is('Failed')(found) || ServiceCatalog.guards.Unavailable(found.value)) {
    return (
      <p className="text-label text-ink-3">
        Vivid can’t reach its list of services right now. Everything else works.{' '}
        <button
          type="button"
          onClick={onAgain}
          className="cursor-pointer rounded-xs text-ink-2 underline underline-offset-4 hover:text-ink focus-visible:text-ink"
        >
          Look again
        </button>
      </p>
    )
  }
  // A stable sort: services not named in `FIRST` keep the order the catalog gave them.
  const shown = Arr.sort(found.value.services, byEveryday).slice(0, SHOWN)
  if (shown.length === 0) {
    return <p className="mt-6 text-center text-label text-ink-3">No service by that name.</p>
  }
  const unavailable = shown.some((service) =>
    ServiceAuthorization.guards.SetupRequired(service.authorization),
  )
  return (
    <>
      <ul className={GRID}>
        {shown.map((service) => (
          <Tile
            key={service.id}
            service={service}
            connected={connected.includes(service.id)}
            pressed={Option.fromUndefinedOr(pressed.get(service.id))}
            onConnect={() => onConnect(service)}
          />
        ))}
      </ul>
      <Under unavailable={unavailable} total={found.value.total} />
    </>
  )
}

/** The small print under the grid: what greyed-out means, and the way to every other service. */
function Under({ unavailable, total }: { unavailable: boolean; total: number }) {
  return (
    <p className="mt-3 text-meta font-meta text-pretty text-ink-3">
      {unavailable && 'The greyed-out ones are not available on this server yet. '}
      <button
        type="button"
        onClick={() => router.openSettings(Option.some('connections'))}
        className="cursor-pointer rounded-xs text-ink-2 underline underline-offset-4 hover:text-ink focus-visible:text-ink"
      >
        Search all {total.toLocaleString()} services
      </button>
    </p>
  )
}

/** One service: something to press, a settled fact once connected, or plainly not on offer. */
function Tile({
  service,
  connected,
  pressed,
  onConnect,
}: {
  service: Service
  connected: boolean
  pressed: Option.Option<Pressed>
  onConnect: () => void
}) {
  if (connected) {
    return (
      <li className={cn(TILE, 'edge-accent')}>
        <Mark service={service} />
        <Named name={service.name}>
          {/* The fact steps up into the line's place as the tile turns from a button into it. */}
          <span className="motion-tick">
            <span className="inline-flex items-center gap-1 text-success">
              <Check className="size-3" strokeWidth={2.25} />
              Connected
            </span>
          </span>
        </Named>
      </li>
    )
  }
  if (ServiceAuthorization.guards.SetupRequired(service.authorization)) {
    return (
      // Not a button and not pointer-styled: there is nothing a Person here can do with it yet.
      <li className={cn(TILE, 'cursor-default opacity-55')}>
        <Mark service={service} />
        <Named name={service.name}>Not available on this server</Named>
      </li>
    )
  }
  return (
    <li>
      <button
        type="button"
        onClick={onConnect}
        aria-label={`Connect ${service.name}`}
        className={cn(
          TILE,
          'cursor-pointer transition-press duration-(--dur-fast) hover:bg-surface-2 hover:edge-field focus-visible:edge-accent active:scale-96',
        )}
      >
        <Mark service={service} />
        <Named name={service.name}>
          {Option.isSome(pressed) && (
            <span className={TONE[pressed.value]}>{PRESSED[pressed.value]}</span>
          )}
        </Named>
      </button>
    </li>
  )
}

/** A tile's name, with one short line under it when the tile has something to say. */
function Named({ name, children }: { name: string; children?: React.ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-label font-title text-ink">{name}</span>
      {children !== undefined && children !== null && children !== false && (
        <span className="block truncate text-meta font-meta text-ink-3">{children}</span>
      )}
    </span>
  )
}
