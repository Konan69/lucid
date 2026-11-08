import type { Connection, ThreadId } from '@vivid/contracts'
import { access } from '@vivid/state'
import { Effect, Option, Result } from 'effect'
import { Alert, View } from 'react-native'
import { start } from '../../data/app'
import { commit } from '../../data/haptics'
import { cardSaid } from '../../data/integration'
import { useLiveData, useLiveValue } from '../../data/live'
import { carryOn } from '../../data/threads'
import { useTheme } from '../../theme'
import { EDGE, Label, Notice, radius } from '../../ui/ui'
import { CardButton } from './Card'
import { useFlow } from './flow'
import { KeyForm } from './Key'
import { Logo } from './Logo'

/**
 * A call through one of the Person's accounts that the account could not make, drawn where Vivid
 * stopped, with what lets it go on (`access.Escalation`):
 *
 * - The Person keeps a kind of data from Vivid on this account (`Declined`): "Allow" lifts it for
 *   the classes the call needed, the same switch the account's sheet has, and the Thread carries
 *   on; "Keep them out" carries it on with the Person's no.
 * - The account was not given what the call needs (`MoreAccess`): one waiting on a sign-in is
 *   picked up where it stopped ("Reconnect"); a working one is signed in to again from the start
 *   ("Sign in again"), since the service grants more only on a new sign-in. The Thread carries on
 *   with the account that came back.
 *
 * It is the Integration card's one row (`IntegrationCard`, `Card.tsx`), so a Thread has one way of
 * asking for access. Adapted from the web's `AccessCard` (`apps/web/src/screen/thread/Cards.tsx`).
 */
export function AccessCard({
  id,
  escalation,
  current,
  thread,
}: {
  /** The tool call this card stands for, which names its attempt and its one "carry on". */
  id: string
  escalation: access.Escalation
  /** Whether this is the newest thing in the Thread and Vivid has stopped to wait for it. */
  current: boolean
  thread: ThreadId
}) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const connections = useLiveValue(data.live.connections)
  const list = Option.match(connections, { onNone: () => [], onSome: (value) => value.connections })
  const connection = Option.fromUndefinedOr(
    list.find((each) => each.account === escalation.account),
  )
  const onCarryOn = (message: string) => carryOn(data, thread, message)
  return (
    <View
      style={{
        padding: 12,
        gap: 10,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c['border-subtle'],
        backgroundColor: c.screen,
      }}
    >
      {access.Escalation.$match(escalation, {
        Declined: (declined) => (
          <Declined
            id={id}
            declined={declined}
            connection={connection}
            current={current}
            onCarryOn={onCarryOn}
          />
        ),
        MoreAccess: (more) => (
          <MoreAccess
            id={id}
            account={more.account}
            connection={connection}
            current={current}
            onCarryOn={onCarryOn}
          />
        ),
      })}
    </View>
  )
}

/** The card's head: the account's logo and name, and the line under it. */
function Head({
  account,
  connection,
  line,
  tone,
}: {
  account: string
  connection: Option.Option<Connection>
  line: string
  tone: 'ink-2' | 'status-success'
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
      {Option.isSome(connection) && (
        <Logo
          service={connection.value.service}
          mark={Option.fromNullishOr(connection.value.mark)}
          size={36}
        />
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label numberOfLines={1} size="footnote" style={{ fontWeight: '600' }}>
          {account}
        </Label>
        <Label accessibilityLiveRegion="polite" size="label" tone={tone}>
          {line}
        </Label>
      </View>
    </View>
  )
}

/** A card for kinds of data the Person keeps from Vivid on the account. */
function Declined({
  id,
  declined,
  connection,
  current,
  onCarryOn,
}: {
  id: string
  declined: Extract<access.Escalation, { readonly _tag: 'Declined' }>
  connection: Option.Option<Connection>
  current: boolean
  onCarryOn: (message: string) => void
}) {
  const data = useLiveData()
  const flow = useFlow()
  const named = access.classesSaid(declined.classes)
  // Allowed now when every class the call needed is allowed on the account as it stands live.
  const allowed = Option.exists(connection, (each) =>
    access
      .dataClassesOf(each)
      .every((entry) => !declined.classes.includes(entry.dataClass) || entry.allowed),
  )
  const allow = (each: Connection) =>
    start(
      Effect.gen(function* () {
        commit()
        for (const dataClass of declined.classes) {
          const result = yield* data.changing((client) =>
            client.SetConnectionPermission({ id: each.id, dataClass, decision: 'Allow' }),
          )
          if (Result.isFailure(result)) {
            Alert.alert(`${named} could not be allowed`, 'Try again.')
            return
          }
        }
        // Said for Vivid only once the server took every class, and only while the Thread still
        // waits on this card: a card further up is a record, not a question.
        if (current) {
          flow.carriedOn(id)
          onCarryOn(`I allowed ${named} on ${declined.account}. Try again.`)
        }
      }),
    )
  return (
    <>
      <Head
        account={declined.account}
        connection={connection}
        line={allowed ? `${named} allowed` : `You keep ${named} from Vivid here`}
        tone={allowed ? 'status-success' : 'ink-2'}
      />
      {!allowed && Option.isSome(connection) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginLeft: 47 }}>
          <CardButton
            label={`Allow ${named}`}
            kind="primary"
            disabled={false}
            onPress={() => void allow(connection.value)}
          />
          {current && (
            <CardButton
              label="Keep them out"
              kind="quiet"
              disabled={false}
              onPress={() => {
                commit()
                flow.carriedOn(id)
                onCarryOn(`Keep ${named} on ${declined.account} out of it.`)
              }}
            />
          )}
        </View>
      )}
    </>
  )
}

/** A card for an account that was not given what the call needs. */
function MoreAccess({
  id,
  account,
  connection,
  current,
  onCarryOn,
}: {
  id: string
  account: string
  connection: Option.Option<Connection>
  current: boolean
  onCarryOn: (message: string) => void
}) {
  const flow = useFlow()
  if (Option.isNone(connection)) {
    return (
      <Head
        account={account}
        connection={connection}
        line="This account is no longer connected."
        tone="ink-2"
      />
    )
  }
  const each = connection.value
  const resume = access.canReconnect(each)
  const keying = flow.keying(Option.some(id))
  const said = cardSaid(flow.standingOfCard(id), {
    starting: 'Opening…',
    serviceName: each.serviceName,
  })
  const press = () => {
    flow.owe(id, (back) => {
      if (current) onCarryOn(`${back.account} has the access now. Try again.`)
    })
    if (resume) flow.resume(each.id, Option.some(id))
    else flow.add(each.service, false, Option.fromNullOr(each.name), Option.some(id))
  }
  return (
    <>
      <Head
        account={account}
        connection={connection}
        line={Option.match(
          Option.filter(said.line, (line) => !line.urgent),
          { onNone: () => 'Needs more access than it was given', onSome: (line) => line.words },
        )}
        tone="ink-2"
      />
      <View style={{ marginLeft: 47, gap: 10 }}>
        {Option.isSome(said.line) && said.line.value.urgent && (
          <Notice message={said.line.value.words} />
        )}
        {Option.isSome(keying) ? (
          <KeyForm keying={keying.value} />
        ) : (
          <View style={{ flexDirection: 'row' }}>
            <CardButton
              label={Option.getOrElse(said.button, () => (resume ? 'Reconnect' : 'Sign in again'))}
              kind="primary"
              disabled={flow.busy}
              onPress={press}
            />
          </View>
        )}
      </View>
    </>
  )
}
