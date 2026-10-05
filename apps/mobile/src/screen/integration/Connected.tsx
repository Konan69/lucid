import { ConnectionOwnership, ConnectionState, type Connection } from '@vivid/contracts'
import { Option } from 'effect'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { Building2, Unplug } from 'lucide-react-native'
import {
  accountLine,
  ownFirst,
  standingOf,
  type Pressed,
  type StandingTone,
} from '../../data/integration'
import { useTheme } from '../../theme'
import { Row, Section } from '../../ui/List'
import { Button, Card, Dot, IconButton, Label } from '../../ui/ui'
import type { Flow } from './flow'
import { Logo } from './Logo'

/**
 * The day an account was added, as this phone writes a short date ("3 Oct", "Oct 3"). The
 * phone's engine has `Intl.DateTimeFormat`, the formatter `data/when.ts` is built on; `when`
 * itself writes a time of day for today, which is not what tells two accounts apart.
 */
const added = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const addedOn = (moment: number) => added.format(moment)

/**
 * What is connected, first in the sheet. With nothing connected it is the one sentence that says
 * how connecting works; while the Person is searching for something else, an empty answer here
 * is left out.
 *
 * Ported from the web (`Connected` in `apps/web/src/screen/settings/Connections.tsx`): the same
 * order, count, standing and words, as rows of one list where the web lays out tiles.
 */
export function Connected({
  connections,
  searching,
  company,
  admin,
  marks,
  flow,
}: {
  /** The accounts whose service answers to the search, in the server's order. */
  connections: ReadonlyArray<Connection>
  searching: boolean
  /** The Company's name, in a Company's workspace. */
  company: Option.Option<string>
  admin: boolean
  /** The icon address the catalog gives each service, for an account that carries none. */
  marks: ReadonlyMap<Connection['service'], string>
  flow: Flow
}) {
  if (connections.length === 0) return searching ? null : <NothingConnected />
  // The count is of accounts that work now. A sign-in that was started and never finished is
  // listed, so it can be finished or removed, but it is not counted as connected.
  const working = connections.filter((item) => ConnectionState.guards.Ready(item.state)).length
  return (
    <Section
      title={`Connected · ${working}`}
      detail={Option.getOrUndefined(
        Option.map(
          company,
          (name) => `Yours act only for you. Every member’s Vivid can read through ${name}’s.`,
        ),
      )}
    >
      {ownFirst(connections).map((connection) => {
        const own = ConnectionOwnership.guards.Personal(connection.ownership)
        return (
          <Account
            key={connection.id}
            connection={connection}
            sharedWith={own ? Option.none() : company}
            pressed={Option.fromUndefinedOr(flow.presses.get(connection.id))}
            mark={Option.orElse(Option.fromNullishOr(connection.mark), () =>
              Option.fromUndefinedOr(marks.get(connection.service)),
            )}
            // A Company's Integration is finished or removed by an admin, never by a member.
            actions={own || admin ? Option.some(flow) : Option.none()}
          />
        )
      })}
    </Section>
  )
}

/**
 * Nothing is connected and nothing is being searched for: what this place is and how to fill it.
 * The catalog under it is what the Person came to press, so this stays two short lines.
 */
function NothingConnected() {
  return (
    <Card style={{ gap: 4 }}>
      <Label accessibilityRole="header" size="footnote">
        Nothing connected yet
      </Label>
      <Label size="label" tone="ink-2">
        Pick what you use below. You sign in on the service’s own page, and Vivid never sees your
        password.
      </Label>
    </Card>
  )
}

/**
 * One connected account: the service's logo with its standing as a dot on the corner, its name,
 * and in words how it stands and which account it is. One that works offers "Disconnect". One
 * that does not leads with "Reconnect" on a line of its own, where it is the widest thing in the
 * row and cannot be missed, and keeps disconnecting as the icon at the trailing edge.
 */
function Account({
  connection,
  sharedWith,
  pressed,
  mark,
  actions,
}: {
  connection: Connection
  /** The Company this account is shared with, when it is not the Person's own. */
  sharedWith: Option.Option<string>
  pressed: Option.Option<Pressed>
  mark: Option.Option<string>
  /** Present for whoever may finish or remove this Integration. */
  actions: Option.Option<Pick<Flow, 'resume' | 'disconnect'>>
}) {
  const ready = ConnectionState.guards.Ready(connection.state)
  // One press at a time: the row is not pressed again while the server is still being asked.
  const asking = Option.exists(pressed, (value) => value === 'starting' || value === 'checking')
  return (
    <View>
      <Row
        leading={
          <Standing tone={standingOf(connection).tone}>
            <Logo service={connection.service} mark={mark} />
          </Standing>
        }
        title={connection.serviceName}
        detail={accountLine(connection, pressed, addedOn)}
        trailing={
          <Trailing
            connection={connection}
            sharedWith={sharedWith}
            ready={ready}
            onDisconnect={Option.map(actions, (flow) => () => flow.disconnect(connection))}
          />
        }
      />
      {!ready && Option.isSome(actions) && (
        // Under the words, starting where they start (the row's 16, the 40 of the logo, its 12).
        <View style={{ paddingLeft: 68, paddingRight: 16, paddingBottom: 12 }}>
          <Button
            label="Reconnect"
            disabled={asking}
            onPress={() => actions.value.resume(connection)}
          />
        </View>
      )}
    </View>
  )
}

/**
 * A logo with the account's standing on its corner, the way a phone marks a contact as present.
 * The dot sits on a ring of the card's own fill so it reads against any artwork. It is never the
 * only sign: the row's second line says the same thing in words.
 */
function Standing({ tone, children }: { tone: StandingTone; children: ReactNode }) {
  const { colors: c } = useTheme()
  return (
    <View>
      {children}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          end: -4,
          bottom: -4,
          padding: 2,
          borderRadius: 7,
          backgroundColor: c['grouped-card'],
        }}
      >
        <Dot tone={tone} size={10} />
      </View>
    </View>
  )
}

/**
 * The trailing edge of an account's row: the mark of an account the whole Company shares, then
 * the way to disconnect it for whoever may. Nothing at all for a member looking at their own
 * Company's account with no mark to show.
 */
function Trailing({
  connection,
  sharedWith,
  ready,
  onDisconnect,
}: {
  connection: Connection
  sharedWith: Option.Option<string>
  ready: boolean
  onDisconnect: Option.Option<() => void>
}) {
  const { colors: c } = useTheme()
  if (Option.isNone(sharedWith) && Option.isNone(onDisconnect)) return null
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {Option.isSome(sharedWith) && (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={`Shared with everyone at ${sharedWith.value}`}
        >
          <Building2 pointerEvents="none" size={16} strokeWidth={1.7} color={c['ink-3']} />
        </View>
      )}
      {Option.isSome(onDisconnect) &&
        (ready ? (
          // The label of a shapeless button ends 20 points inside it; pulled out so the word,
          // not the empty shape, lines up near the row's own edge.
          <Button
            kind="ghost"
            label="Disconnect"
            onPress={onDisconnect.value}
            containerStyle={{ marginEnd: -12 }}
          />
        ) : (
          <View style={{ marginEnd: -8 }}>
            <IconButton
              icon={Unplug}
              label={`Disconnect ${connection.serviceName}`}
              onPress={onDisconnect.value}
            />
          </View>
        ))}
    </View>
  )
}
