import { ServiceAuthorization, ServiceCatalog, type Service } from '@vivid/contracts'
import { LiveState } from '@vivid/state'
import { Option } from 'effect'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { Check, CloudOff, Plus, SearchX } from 'lucide-react-native'
import { noteOf, type Pressed, type Presses } from '../../data/integration'
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
  connected,
  presses,
  onConnect,
  onAgain,
  whose,
}: {
  found: LiveState<ServiceCatalog>
  searching: boolean
  /** The services this Person already has a ready Integration with. */
  connected: ReadonlyArray<Service['id']>
  presses: Presses
  onConnect: (service: Service) => void
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
              connected={connected.includes(service.id)}
              pressed={Option.fromUndefinedOr(presses.get(service.id))}
              onConnect={() => onConnect(service)}
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
 * a row that goes somewhere. A connected service can be pressed again: that adds another account.
 */
function ServiceRow({
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
  const Mark = connected ? Check : Plus
  return (
    <Row
      leading={leading}
      title={service.name}
      detail={detail}
      trailing={
        <Mark
          pointerEvents="none"
          size={18}
          strokeWidth={connected ? 2 : 1.7}
          color={connected ? c['status-success'] : c.chevron}
        />
      }
      onPress={onConnect}
    />
  )
}
