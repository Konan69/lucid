import { ConnectionState, type ConnectionId } from '@vivid/contracts'
import { Option, Redacted, Result } from 'effect'
import { useState } from 'react'
import { commit } from '../../data/haptics'
import type { KeyFields } from '../../data/integration'
import { useLiveData } from '../../data/live'
import { Sheet } from '../../ui/Sheet'
import { Button, Field, Labelled, Notice } from '../../ui/ui'

/** An Integration that is waiting for its key: which one, what to call it, and what it asks for. */
export interface Keying {
  readonly id: ConnectionId
  readonly name: string
  readonly fields: KeyFields
}

/**
 * What has been typed, by the name the service gave each field. A value is wrapped the moment it
 * leaves its input and is never unwrapped on this phone: the wrapped value is what is sent, and a
 * wrapped value prints as `<redacted>` wherever it might end up. A field with nothing in it is
 * simply not here, which is how the form knows whether it can be sent.
 */
type Typed = ReadonlyMap<string, Redacted.Redacted>

/** What the Person is told when the key did not connect the Integration. */
const NOT_ACCEPTED = 'That was not accepted. Check it and try again.'

/** What is held after one field changed. */
const afterTyping = (held: Typed, name: string, text: string): Typed => {
  const next = new Map(held)
  if (text.length === 0) next.delete(name)
  else next.set(name, Redacted.make(text))
  return next
}

/**
 * Collects the key a service asks for, in a sheet over the Thread. The key goes straight to the
 * Integration (`CompleteConnection`) and nowhere else: it is not put in a message, it is not
 * shown to Vivid, it is not logged, and it is held only in this sheet's own state, which is gone
 * when the sheet is. The inputs keep their own text (they are given no `value`), so nothing here
 * ever reads a key back to draw it.
 *
 * The inputs are the platform's secure ones: masked, never offered to the keyboard's suggestions
 * or to autofill, and left out of what Android may fill on the Person's behalf.
 *
 * Adapted from the web's dialog (`apps/web/src/screen/integration/Key.tsx`).
 */
export function EnterKey({
  keying,
  onClose,
  onConnected,
}: {
  keying: Keying
  onClose: () => void
  /** The service took the key and the Integration is ready; the card turns to "Carry on". */
  onConnected: () => void
}) {
  const data = useLiveData()
  const [typed, setTyped] = useState<Typed>(new Map())
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const complete = keying.fields.every((field) => typed.has(field.name))

  async function submit() {
    if (!complete || busy) return
    // Felt as the Person commits, not when the answer comes back.
    commit()
    setBusy(true)
    setRefused(Option.none())
    const result = await data.change((client) =>
      client.CompleteConnection({ id: keying.id, fields: Object.fromEntries(typed) }),
    )
    setBusy(false)
    // The server taking the call is not the service taking the key: the answer says where the
    // Integration stands now, and only "ready" closes the sheet. Anything else keeps it up with
    // what was typed still in it, to be corrected and sent again.
    const refusal = Result.isFailure(result)
      ? Option.some(NOT_ACCEPTED)
      : ConnectionState.match(result.success.connection.state, {
          Ready: () => Option.none<string>(),
          NeedsAuthorization: () => Option.some(NOT_ACCEPTED),
          Failed: ({ reason }) => Option.some(`${keying.name} did not accept that: ${reason}`),
        })
    if (Option.isSome(refusal)) {
      setRefused(refusal)
      return
    }
    onConnected()
    onClose()
  }

  return (
    <Sheet
      title={`Connect ${keying.name}`}
      detail="This goes straight to the integration and is never shown to Vivid or kept in a thread."
      onClose={onClose}
    >
      {keying.fields.map((field, place) => (
        <Labelled key={field.name} label={field.label}>
          <Field
            accessibilityLabel={field.label}
            autoFocus={place === 0}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            returnKeyType="done"
            onChangeText={(text) => setTyped((held) => afterTyping(held, field.name, text))}
            // Does nothing until every field has something in it.
            onSubmitEditing={() => void submit()}
          />
        </Labelled>
      ))}
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Button
        kind="primary"
        label={busy ? 'One moment…' : 'Connect'}
        disabled={busy || !complete}
        onPress={() => void submit()}
      />
    </Sheet>
  )
}
