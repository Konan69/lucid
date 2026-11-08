import type { ConnectionId } from '@vivid/contracts'
import type { connecting } from '@vivid/state'
import { Effect, Option, Redacted, Result } from 'effect'
import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { commit } from '../../data/haptics'
import { useLiveData } from '../../data/live'
import { Button, Field, Label, Labelled, Notice } from '../../ui/ui'
import { start } from '../../data/app'

/**
 * What has been typed, by the name the service gave each field. A value is wrapped the moment it
 * leaves its input and is never unwrapped on this phone: the wrapped value is what is sent, and a
 * wrapped value prints as `<redacted>` wherever it might end up. A field with nothing in it is
 * simply not here, which is how the form knows whether it can be sent.
 */
type Typed = ReadonlyMap<string, Redacted.Redacted>

/** What the Person is told when the call that sends the key did not get through. */
const NOT_ACCEPTED = 'That was not accepted. Check it and try again.'

/** What is held after one field changed. */
const afterTyping = (held: Typed, name: string, text: string): Typed => {
  const next = new Map(held)
  if (text.length === 0) next.delete(name)
  else next.set(name, Redacted.make(text))
  return next
}

/**
 * An account waiting for its key, as the machine's `Keying` state holds it: the attempt it
 * belongs to, the account, the service's name and the fields it asks for.
 */
export interface Keying {
  readonly attempt: { readonly id: connecting.AttemptId }
  readonly id: ConnectionId
  readonly serviceName: string
  readonly fields: ReadonlyArray<{ readonly name: string; readonly label: string }>
}

/**
 * Collects the key a service asks for, inside the Integration's own card: the card in a Thread,
 * or the account's card on the Integrations page. The key goes straight to the Integration
 * (`CompleteConnection`) and nowhere else: it is not put in a message, it is not shown to Vivid,
 * it is not logged, and it is held only in this form's own state, which is gone when the form
 * is. The inputs keep their own text (they are given no `value`), so nothing here ever reads a
 * key back to draw it.
 *
 * The inputs are the platform's secure ones: masked, never offered to the keyboard's suggestions
 * or to autofill, and left out of what Android may fill on the Person's behalf.
 *
 * It was a bottom sheet over whatever asked (the `Key` route) until the approved mockup 4 of
 * 26 October 2026 (issue #126): the key is typed where the Integration is. The card draws this
 * while the machine stands in `Keying` for it (`keyingFor`, `data/connecting.ts`), and tells the
 * machine how it ends (`keySheet`): the server answered its call with the account, or the Person
 * pressed Cancel. A form scrolled out of a list is not an ending: the attempt keeps waiting and
 * the form is drawn again when its card is.
 *
 * An answer ends the form whether or not the service took the key. After one completion the
 * account no longer waits for a key and the server takes no second one (`makeComplete`,
 * `apps/server/src/connections/executor.ts`), so the card says the service did not accept it.
 * Only the call itself failing keeps the form up.
 *
 * What this keeps is the form's own: what is typed, and its own call to the Integration. That
 * call's `busy` and `refused` are still set after it answers.
 *
 * Adapted from the web's form (`apps/web/src/screen/integration/Key.tsx`).
 */
export function KeyForm({ keying }: { keying: Keying }) {
  const { attempt, id, serviceName, fields } = keying
  const data = useLiveData()
  const [typed, setTyped] = useState<Typed>(new Map())
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const complete = fields.every((field) => typed.has(field.name))
  // This showing of the form, and how its one ending is said to the machine.
  const ending = useMemo(() => data.connecting.keySheet(attempt.id), [data, attempt.id])

  function submit() {
    return start(
      Effect.gen(function* () {
        if (!complete || busy) return
        // Felt as the Person commits, not when the answer comes back.
        commit()
        setBusy(true)
        setRefused(Option.none())
        const result = yield* data.changing((client) =>
          client.CompleteConnection({ id, fields: Object.fromEntries(typed) }),
        )
        setBusy(false)
        // The call itself did not get through: nothing was completed, so the form stays up with
        // what was typed still in it, to be sent again.
        if (Result.isFailure(result)) {
          setRefused(Option.some(NOT_ACCEPTED))
          return
        }
        // Every answer that holds an account is this form's ending, whether or not the service
        // took the key: the machine decides, and the card says which.
        ending.answered(result.success.connection)
      }),
    )
  }

  return (
    <View style={{ gap: 10 }}>
      {fields.map((field, place) => (
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
      <Label size="caption" tone="ink-3">
        It goes straight to {serviceName}. Vivid never sees it and it is never kept in a thread.
      </Label>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
        <Button kind="ghost" label="Cancel" disabled={busy} onPress={ending.closed} />
        <Button
          morph
          kind="primary"
          label={busy ? 'One moment…' : 'Connect'}
          disabled={busy || !complete}
          onPress={() => void submit()}
        />
      </View>
    </View>
  )
}
