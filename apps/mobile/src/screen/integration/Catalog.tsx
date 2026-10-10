import {
  ServiceAuthorization,
  ServiceCatalog,
  type Connection,
  type Service,
} from '@vivid/contracts'
import { connecting, LiveState } from '@vivid/state'
import { Option } from 'effect'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { Check, CloudOff, Plus, SearchX } from 'lucide-react-native'
import { noteOf } from '../../data/integration'
import { useTheme } from '../../theme'
import { Row, Section } from '../../ui/List'
import { Button, Empty } from '../../ui/ui'
import { Logo } from './Logo'
import { byPurpose } from './purpose'

/** How many rows stand in for the catalog while its first answer is on its way. */
const SLOTS = ['a', 'b', 'c', 'd', 'e', 'f'] as const

/**
 * The services Vivid can be connected to. Before anything is typed it shows the ones most people
 * want, in groups by what they are for, so the common case is one press; typing searches the
 * whole catalog by name. The server answers with its best two dozen, so the list is never the
 * whole catalog. The last answer stays up while the next is on its way (`engine.ask`), so the
 * list does not blink between keystrokes.
 *
 * Ported from the web (`Catalog` in `apps/web/src/screen/settings/Connections.tsx`): the same
 * four states and the same words, as grouped lists where the web lays out a grid of tiles.
 */
export function Catalog({
  found,
  searching,
  ready,
  standing,
  busy,
  onConnect,
  onAgain,
  whose,
}: {
  found: LiveState<ServiceCatalog>
  searching: boolean
  /** The accounts this Person can use now; a service with one of them is already connected. */
  ready: ReadonlyArray<Connection>
  /** Where the attempt made on a service's row stands; only the row that was pressed speaks. */
  standing: (service: Service['id']) => connecting.Standing
  /** Whether nothing can be pressed for now: the server is being asked, here or anywhere. */
  busy: boolean
  /** Adds an account on a service, given the accounts the Person already has on it. */
  onConnect: (service: Service, accounts: ReadonlyArray<Connection>) => void
  /** Asks the catalog again, after it could not be reached. */
  onAgain: () => void
  /** The admin's choice of who the next Integration is for, when there is one to make. */
  whose: ReactNode
}) {
  if (LiveState.$is('Loading')(found)) {
    return (
      <View style={{ gap: 16 }}>
        {whose}
        <View accessibilityRole="progressbar" accessibilityLabel="Looking through the integrations">
          <Section title={searching ? 'Results' : 'Popular'}>
            {SLOTS.map((slot) => (
              <Placeholder key={slot} />
            ))}
          </Section>
        </View>
      </View>
    )
  }
  if (LiveState.$is('Failed')(found) || ServiceCatalog.guards.Unavailable(found.value)) {
    return (
      <Empty
        icon={CloudOff}
        title="The list is out of reach"
        line="Vivid can’t reach its list of integrations right now. What you have connected still works."
        room="section"
      >
        <Button label="Look again" onPress={onAgain} />
      </Empty>
    )
  }
  const { services } = found.value
  if (services.length === 0)
    return <Empty icon={SearchX} title="No integration by that name" room="section" />
  // A search is one answer in the catalog's order; the unsearched view is the same answer in
  // groups, so a Person looking for "something for mail" finds the shelf before the name.
  const groups = searching ? [{ purpose: 'Results', services }] : byPurpose(services)
  return (
    <View style={{ gap: 24 }}>
      {whose}
      {groups.map((group) => (
        <Section key={group.purpose} title={group.purpose}>
          {group.services.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              connected={ready.some((item) => item.service === service.id)}
              pressed={standing(service.id)}
              busy={busy}
              onConnect={() =>
                onConnect(
                  service,
                  ready.filter((item) => item.service === service.id),
                )
              }
            />
          ))}
        </Section>
      ))}
    </View>
  )
}

/**
 * The outline of one row: a logo's square and a name's bar, at a real row's height (its 10
 * points above and below a 40-point logo), so nothing jumps when the rows arrive. It is still;
 * a loading list should not cost a frame.
 */
function Placeholder() {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        height: 60,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 9,
          borderCurve: 'continuous',
          backgroundColor: c['wash-hover'],
        }}
      />
      <View
        style={{ height: 13, width: '42%', borderRadius: 7, backgroundColor: c['wash-pressed'] }}
      />
    </View>
  )
}

/**
 * One service in the catalog: a row to press, a settled fact once connected, or plainly not on
 * offer. A service nobody can connect on this installation (its sign-in was never registered by
 * whoever runs this Vivid) is still shown, says so, steps back, and is not a button.
 *
 * Pressing connects there and then, so the row's trailing mark is a plus and not the chevron of
 * a row that goes somewhere. A connected service can be pressed again, and that adds another
 * account: its row says so under the name, beside the check that says it is connected, and keeps
 * the plus, because pressing it still adds something.
 *
 * While the server is being asked, here or anywhere, no row is a button: the machine takes one
 * press at a time, and a row left enabled either did nothing when pressed or opened the sheet
 * that names an account whose press would then not be taken. The rows step back as one that is
 * not on offer does; the row whose own attempt is speaking keeps its full ink, so "Connecting…"
 * stays as easy to read as it was.
 */
function ServiceRow({
  service,
  connected,
  pressed,
  busy,
  onConnect,
}: {
  service: Service
  connected: boolean
  /** Where the attempt made on this row stands. */
  pressed: connecting.Standing
  /** Whether nothing can be pressed for now. */
  busy: boolean
  onConnect: () => void
}) {
  const { colors: c } = useTheme()
  const detail = Option.getOrUndefined(noteOf(service, connected, pressed))
  const leading = <Logo service={service.id} mark={Option.fromNullishOr(service.mark)} />
  if (ServiceAuthorization.guards.SetupRequired(service.authorization)) {
    return (
      <View style={{ opacity: 0.6 }}>
        <Row leading={leading} title={service.name} detail={detail} />
      </View>
    )
  }
  const trailing = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {connected && (
        <Check pointerEvents="none" size={18} strokeWidth={2} color={c['status-success']} />
      )}
      <Plus pointerEvents="none" size={18} strokeWidth={1.7} color={c.chevron} />
    </View>
  )
  if (busy) {
    const speaking = !connecting.Standing.guards.Still(pressed)
    return (
      <View accessibilityState={{ disabled: true }} style={{ opacity: speaking ? 1 : 0.6 }}>
        <Row leading={leading} title={service.name} detail={detail} trailing={trailing} />
      </View>
    )
  }
  return (
    <Row
      leading={leading}
      title={service.name}
      detail={detail}
      trailing={trailing}
      onPress={onConnect}
    />
  )
}
