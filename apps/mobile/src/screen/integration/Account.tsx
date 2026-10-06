import {
  ACCOUNT_NAME_MAX,
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
import { Sheet } from '../../ui/Sheet'
import { Button, Field, Label, Labelled, Notice } from '../../ui/ui'

/** What a form says when the name typed is one another account on the service already has. */
const TAKEN = 'Another account here is already called that. Choose a different name.'

/** Why a Person is asked for a name before one more account is added to this service. */
export const whyName = (serviceName: string) =>
  `${serviceName} does not say who signs in. A name is how you and Vivid tell your accounts apart.`

/**
 * One account's own sheet, opened by pressing its row: name it, add one more account on the same
 * service, or disconnect it. A phone has no room for those three on a row, so they are here,
 * where a phone keeps what can be done to one thing.
 *
 * The same features as the web's row (`AccountRow` and `AddAccount` in
 * `apps/web/src/screen/settings/Connections.tsx`), as one sheet:
 *
 * - The name is the Person's own word for the account ("Work"). It is what Vivid calls the
 *   account too, and it never reaches the service. Saving nothing takes the name away again.
 * - "Add another account" begins one more account on this service. Where the service does not say
 *   who signs in, the sheet first asks what to call the new one, in place, so no second sheet is
 *   opened over this one.
 * - Disconnecting asks first, with the system's own alert (`flow.disconnect`).
 */
export function ManageAccount({
  connection,
  accounts,
  onClose,
  onRename,
  onAdd,
  onDisconnect,
}: {
  connection: Connection
  /** Every account the Person can see on this account's service, this one included. */
  accounts: ReadonlyArray<Connection>
  onClose: () => void
  /** Answers with nothing when the name was saved, or with the sentence to show when it was not. */
  onRename: (name: Option.Option<AccountName>) => Promise<Option.Option<string>>
  /** Begins one more account on the service; present only where the service takes another. */
  onAdd: Option.Option<(name: Option.Option<AccountName>) => void>
  onDisconnect: () => void
}) {
  const [adding, setAdding] = useState(false)
  const which = whichAccount(connection, accounts.length === 1)
  if (adding && Option.isSome(onAdd)) {
    return (
      <NameNew
        serviceName={connection.serviceName}
        others={accounts}
        onClose={onClose}
        onName={(name) => {
          onClose()
          onAdd.value(Option.some(name))
        }}
      />
    )
  }
  return (
    <Sheet
      title={connection.serviceName}
      detail={Option.getOrElse(which, () => standingOf(connection).words)}
      onClose={onClose}
    >
      <Rename
        connection={connection}
        others={accounts.filter((account) => account.id !== connection.id)}
        onRename={onRename}
      />
      {Option.isSome(onAdd) && (
        <Button
          icon={Plus}
          label={`Add another ${connection.serviceName} account`}
          onPress={() => {
            // A service that says who signed in names the new account itself; begin at once.
            if (asksName(accounts)) {
              setAdding(true)
              return
            }
            onClose()
            onAdd.value(Option.none())
          }}
        />
      )}
      <Button kind="danger" label="Disconnect" onPress={onDisconnect} />
    </Sheet>
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
 * Asks what to call an account that is about to be added, before anything is begun. It is used
 * in the account's sheet, in place, and by itself where a catalog row asked (`flow.naming`).
 */
export function NameNew({
  serviceName,
  others,
  onClose,
  onName,
}: {
  serviceName: string
  /** The accounts already on the service: a name one of them has cannot be given again. */
  others: ReadonlyArray<Connection>
  onClose: () => void
  onName: (name: AccountName) => void
}) {
  const [written, setWritten] = useState('')
  const name = typedAccountName(written)
  const taken = nameTaken(others, name)
  const add = () => {
    if (Option.isNone(name) || taken) return
    commit()
    onName(name.value)
  }
  return (
    <Sheet title="Name the new account" detail={whyName(serviceName)} onClose={onClose}>
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
        disabled={Option.isNone(name) || taken}
        onPress={add}
      />
    </Sheet>
  )
}
