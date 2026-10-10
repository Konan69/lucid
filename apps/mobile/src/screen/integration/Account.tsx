import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import {
  ACCOUNT_NAME_MAX,
  ConnectionOwnership,
  ConnectionState,
  type AccountName,
  type Connection,
} from '@vivid/contracts'
import { asksName, nameTaken, typedAccountName, whichAccount } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { Plus } from 'lucide-react-native'
import { commit } from '../../data/haptics'
import { standingOf } from '../../data/integration'
import { useLiveData, useLiveValue } from '../../data/live'
import { FittedSheet } from '../../ui/Sheet'
import { Button, Field, Label, Labelled, Notice, Skeleton } from '../../ui/ui'
import type { Routes } from '../../workspace'
import { useFlow } from './flow'

/** What a form says when the name typed is one another account on the service already has. */
const TAKEN = 'Another account here is already called that. Choose a different name.'

/** Why a Person is asked for a name before one more account is added to this service. */
const whyName = (serviceName: string) =>
  `${serviceName} does not say who signs in. A name is how you and Vivid tell your accounts apart.`

/**
 * One account's own sheet, opened by pressing its row on the Integrations page: name it, add one
 * more account on the same service, or disconnect it. A phone has no room for those three on a
 * row, so they are here, where a phone keeps what can be done to one thing.
 *
 * It is a route (`Account`, `workspace.ts`) drawn as the platform's bottom sheet, as tall as
 * these few controls (`FITTED_SHEET`, `ui/stack.ts`). It was a full page, most of it empty.
 *
 * The same features as the web's row (`AccountRow` and `AddAccount` in
 * `apps/web/src/screen/settings/Connections.tsx`):
 *
 * - The name is the Person's own word for the account ("Work"). It is what Vivid calls the
 *   account too, and it never reaches the service. Saving nothing takes the name away again.
 * - "Add another account" begins one more account on this service, where this one came from the
 *   catalog (`Connection.origin`): a server added by its address cannot be added a second time
 *   yet. Where the service does not say who signs in, this sheet gives way to the one that asks
 *   what to call the new account (`NameAccount`), so there is one sheet and never two.
 * - Disconnecting asks first, with the system's own alert (`flow.disconnect`).
 *
 * The account is read from the live list by the id the route carries, so the sheet shows the name
 * it has now. One that is no longer in the list (disconnected on another device while this was
 * open) is said in a line; the sheet does not close itself, which would be navigating while it
 * renders.
 */
export function Account({ route, navigation }: NativeStackScreenProps<Routes, 'Account'>) {
  const data = useLiveData()
  const flow = useFlow()
  const connections = useLiveValue(data.live.connections)
  if (Option.isNone(connections)) {
    // The list is warm whenever a row was there to press, so this is the first frame at most.
    return (
      <FittedSheet title="Account">
        <Skeleton rows={2} />
      </FittedSheet>
    )
  }
  const all = connections.value.connections
  const found = all.find((item) => item.id === route.params.id)
  if (found === undefined) {
    return <FittedSheet title="Account" detail="This account is no longer connected." />
  }
  const connection = found
  /** Every account the Person can see on this account's service, this one included. */
  const accounts = all.filter((item) => item.service === connection.service)
  // The new account goes where this one is: the Person's own, or the Company's.
  const shared = ConnectionOwnership.guards.Shared(connection.ownership)

  const another = () => {
    if (asksName(accounts)) {
      navigation.replace('NameAccount', {
        service: connection.service,
        serviceName: connection.serviceName,
        shared,
        // No card asked: this is the Person adding an account from its own sheet.
        card: null,
      })
      return
    }
    // A service that says who signed in names the new account itself: begin at once.
    flow.add(connection.service, shared, Option.none(), Option.none())
    navigation.goBack()
  }

  return (
    <FittedSheet
      title={connection.serviceName}
      detail={Option.getOrElse(
        whichAccount(connection, accounts.length === 1),
        () => standingOf(connection).words,
      )}
    >
      <Rename
        connection={connection}
        others={accounts.filter((account) => account.id !== connection.id)}
        onRename={(name) => flow.rename(connection, name)}
      />
      {connection.origin === 'Catalogue' && (
        <Button
          icon={Plus}
          label={`Add another ${connection.serviceName} account`}
          // Nothing is begun while another press is on its way; the flow would not take it.
          disabled={flow.busy}
          onPress={another}
        />
      )}
      <Button
        kind="danger"
        label="Disconnect"
        // The sheet closes as the Person agrees: it has nothing left to show for the account.
        onPress={() => flow.disconnect(connection, () => navigation.goBack())}
      />
    </FittedSheet>
  )
}

/**
 * The account's name, to give, change or take away. The button is live only when what is typed
 * differs from the name the account has, so it never saves the same thing twice.
 */
function Rename({
  connection,
  others,
  onRename,
}: {
  connection: Connection
  /** The other accounts on its service: a name one of them has cannot be given to this one. */
  others: ReadonlyArray<Connection>
  onRename: (name: Option.Option<AccountName>) => Promise<Option.Option<string>>
}) {
  const current = Option.fromNullOr(connection.name)
  const [written, setWritten] = useState(Option.getOrElse(current, () => ''))
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const name = typedAccountName(written)
  const changed = Option.getOrNull(name) !== connection.name
  // Said under the field while it is typed, so the server is never asked for a name it refuses.
  const taken = nameTaken(others, name)

  async function save() {
    if (!changed || taken || busy) return
    // Felt as the Person commits, not when the answer comes back.
    commit()
    setBusy(true)
    setRefused(Option.none())
    const refusal = await onRename(name)
    setBusy(false)
    setRefused(refusal)
  }

  return (
    <>
      <Labelled label="Name">
        <Field
          accessibilityLabel="Name for this account"
          value={written}
          placeholder="Work"
          maxLength={ACCOUNT_NAME_MAX}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          onChangeText={setWritten}
          onSubmitEditing={() => void save()}
        />
      </Labelled>
      <Label size="label" tone="ink-2">
        Your own name for this account, such as Work. Vivid uses it too. Leave it empty to remove
        the name.
      </Label>
      {taken && <Notice message={TAKEN} />}
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Button
        morph
        kind="primary"
        label={busy ? 'One moment…' : 'Save name'}
        disabled={busy || !changed || taken}
        onPress={() => void save()}
      />
      {/* Said in words too: an account that does not work is why a Person opened this sheet. */}
      {!ConnectionState.guards.Ready(connection.state) && (
        <Label size="label" tone="ink-2">
          {standingOf(connection).words}
        </Label>
      )}
    </>
  )
}

/**
 * Asks what to call an account that is about to be added, before anything is begun: one more on
 * a service that does not say who signs in, where a name is what will tell it from the accounts
 * already there. A route (`NameAccount`) drawn as a bottom sheet as tall as its one field.
 *
 * It is opened from a catalog row, from an account's sheet (which it replaces) and from the card
 * in a Thread. "Add account" begins the account through the shell's one flow and closes the
 * sheet; what the server makes of it is said where the Person pressed, on the row or the card.
 * It knows the accounts already on the service from the live list, so a name that is taken is
 * said before anything is sent.
 */
export function NameAccount({ route, navigation }: NativeStackScreenProps<Routes, 'NameAccount'>) {
  const { service, serviceName, shared, card } = route.params
  const data = useLiveData()
  const flow = useFlow()
  const connections = useLiveValue(data.live.connections)
  const [written, setWritten] = useState('')
  const name = typedAccountName(written)
  const taken = nameTaken(
    Option.match(connections, {
      onNone: () => [],
      onSome: (value) => value.connections.filter((item) => item.service === service),
    }),
    name,
  )
  const add = () => {
    if (Option.isNone(name) || taken || flow.busy) return
    // The flow makes the press felt as it takes it.
    flow.add(service, shared, name, Option.fromNullOr(card))
    navigation.goBack()
  }
  return (
    <FittedSheet title="Name the new account" detail={whyName(serviceName)}>
      <Labelled label="Name">
        <Field
          autoFocus
          accessibilityLabel="Name for the new account"
          value={written}
          placeholder="Work"
          maxLength={ACCOUNT_NAME_MAX}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          onChangeText={setWritten}
          onSubmitEditing={add}
        />
      </Labelled>
      {taken && <Notice message={TAKEN} />}
      <Button
        kind="primary"
        label="Add account"
        // While another press is on its way the flow takes nothing, and going back then would
        // lose the name with no account begun: the button waits, with the name still typed.
        disabled={Option.isNone(name) || taken || flow.busy}
        onPress={add}
      />
    </FittedSheet>
  )
}
