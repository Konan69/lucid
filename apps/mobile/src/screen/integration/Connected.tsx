import { ConnectionOwnership, ConnectionState, type Connection } from '@vivid/contracts'
import { Option } from 'effect'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { byService } from '@vivid/state'
import { accountLine, standingOf, type Presses, type StandingTone } from '../../data/integration'
import { useTheme } from '../../theme'
import { Row, Section } from '../../ui/List'
import { Button, Card, Dot, Label } from '../../ui/ui'
import { Logo } from './Logo'

/**
 * What is connected, first on the page. With nothing connected it is the one sentence that says
 * how connecting works; while the Person is searching for something else, an empty answer here
 * is left out.
 *
 * Ported from the web (`Connected` in `apps/web/src/screen/settings/Connections.tsx`): the same
 * order, count, standing and words. The web draws one card for each service with a row for each
 * account; a phone draws one row for each account in one list, under its service's name, and
 * says which account it is on the second line. Pressing a row opens that account's own sheet.
 */
export function Connected({
  connections,
  searching,
  company,
  admin,
  marks,
  presses,
  onResume,
  onManage,
}: {
  /** The accounts whose service answers to the search, in the server's order. */
  connections: ReadonlyArray<Connection>
  searching: boolean
  /** The Company's name, in a Company's workspace. */
  company: Option.Option<string>
  admin: boolean
  /** The icon address the catalog gives each service, for an account that carries none. */
  marks: ReadonlyMap<Connection['service'], string>
  /** Where each row's last press stands. */
  presses: Presses
  /** Picks up an account whose sign-in was left, or lapsed. */
  onResume: (connection: Connection) => void
  /** Opens the account's own sheet. */
  onManage: (connection: Connection) => void
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
      {/* One service's accounts stay together and in the order they were added, so a second
          Gmail account lands under the first and nothing above it moves (`byService`). */}
      {byService(connections).flatMap((group) =>
        group.accounts.map((connection) => {
          const own = ConnectionOwnership.guards.Personal(connection.ownership)
          const pressed = Option.fromUndefinedOr(presses.get(connection.id))
          return (
            <Account
              key={connection.id}
              connection={connection}
              line={accountLine(connection, {
                alone: group.accounts.length === 1,
                sharedWith: own ? Option.none() : company,
                pressed,
              })}
              // One press at a time: nothing is asked again while the server is still asked.
              asking={Option.exists(
                pressed,
                (value) => value === 'starting' || value === 'checking',
              )}
              mark={Option.orElse(Option.fromNullishOr(connection.mark), () =>
                Option.fromUndefinedOr(marks.get(connection.service)),
              )}
              // A Company's Integration is named, finished or removed by an admin, never a member.
              actions={own || admin ? Option.some({ onResume, onManage }) : Option.none()}
            />
          )
        }),
      )}
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
 * One connected account: the service's logo with its standing as a dot on the corner, the
 * service's name, and in words which account it is. Pressing it opens the account's own sheet,
 * where it is named, added to and disconnected, so the row carries the chevron of a row that
 * goes somewhere. One that does not work also leads with "Reconnect" on a line of its own, where
 * it is the widest thing in the row and cannot be missed.
 */
function Account({
  connection,
  line,
  asking,
  mark,
  actions,
}: {
  connection: Connection
  /** The second line: which account it is and how it stands. */
  line: string
  asking: boolean
  mark: Option.Option<string>
  /** Present for whoever may name, finish or remove this Integration. */
  actions: Option.Option<{
    readonly onResume: (connection: Connection) => void
    readonly onManage: (connection: Connection) => void
  }>
}) {
  const leading = (
    <Standing tone={standingOf(connection).tone}>
      <Logo service={connection.service} mark={mark} />
    </Standing>
  )
  if (Option.isNone(actions)) {
    return <Row leading={leading} title={connection.serviceName} detail={line} />
  }
  return (
    <View>
      <Row
        leading={leading}
        title={connection.serviceName}
        detail={line}
        onPress={() => actions.value.onManage(connection)}
      />
      {!ConnectionState.guards.Ready(connection.state) && (
        // Under the words, starting where they start (the row's 16, the 40 of the logo, its 12).
        <View style={{ paddingLeft: 68, paddingRight: 16, paddingBottom: 12 }}>
          <Button
            label="Reconnect"
            disabled={asking}
            onPress={() => actions.value.onResume(connection)}
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
