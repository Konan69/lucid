import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Effect, Option, Redacted, Result } from 'effect'
import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { commit } from '../../data/haptics'
import { useLiveData } from '../../data/live'
import { FittedSheet } from '../../ui/Sheet'
import { Button, Field, Labelled, Notice } from '../../ui/ui'
import type { Routes } from '../../workspace'
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
 * Collects the key a service asks for, in a bottom sheet over whatever asked: the Integrations
 * page, or the Thread whose card was pressed. The key goes straight to the Integration
 * (`CompleteConnection`) and nowhere else: it is not put in a message, it is not shown to Vivid,
 * it is not logged, and it is held only in this screen's own state, which is gone when the sheet
 * is. The inputs keep their own text (they are given no `value`), so nothing here ever reads a
 * key back to draw it. The route carries what the form asks for, never what is typed into it.
 *
 * The inputs are the platform's secure ones: masked, never offered to the keyboard's suggestions
 * or to autofill, and left out of what Android may fill on the Person's behalf.
 *
 * It is a route on the stack (`Key`, `FITTED_SHEET`). It was a React Native `Modal` mounted from
 * outside the navigator, and a server that asked for a key while the name sheet was still leaving
 * had its form refused by UIKit, which presents one thing at a time; the stack orders its own
 * sheets.
 *
 * The machine opens it, on its way into `Keying` (`KeyForm` in `data/connecting.ts`), and is told
 * how it ends (`keySheet`), by the attempt it was opened for: the server answered its call with
 * the account, which is what the row or card that asked hears; or the sheet was closed without
 * that, by a swipe, the way back, or the shell going. Closing is heard as the sheet's own view
 * leaving, so every way of closing is covered and no effect runs; after an answer that leaving
 * says nothing.
 *
 * An answer closes the sheet whether or not the service took the key. After one completion the
 * account no longer waits for a key and the server takes no second one (`makeComplete`,
 * `apps/server/src/connections/executor.ts`), so keeping the sheet up to "check it and try
 * again" offered a retry the server cannot take; the row or card says the service did not accept
 * it. Only the call itself failing keeps the sheet up.
 *
 * What this screen keeps is the form's own: what is typed, and its own call to the Integration.
 * That call's `busy` and `refused` are still set after it answers; the sheet is modal, so
 * nothing else can be pressed meanwhile.
 *
 * Adapted from the web's dialog (`apps/web/src/screen/integration/Key.tsx`).
 */
export function Key({ route, navigation }: NativeStackScreenProps<Routes, 'Key'>) {
  const { attempt, id, name, fields } = route.params
  const data = useLiveData()
  const [typed, setTyped] = useState<Typed>(new Map())
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const complete = fields.every((field) => typed.has(field.name))
  // This opening of the sheet, and how its one ending is said to the machine: `answered` below,
  // or `closed` as its view leaves. It is made once for the life of the sheet, and so is the ref:
  // React runs a ref's cleanup whenever the ref changes, and this cleanup ends the attempt.
  const sheet = useMemo(() => data.connecting.keySheet(attempt), [data, attempt])
  const closing = useMemo(() => () => sheet.closed, [sheet])

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
        // The call itself did not get through: nothing was completed, so the sheet stays up with
        // what was typed still in it, to be sent again.
        if (Result.isFailure(result)) {
          setRefused(Option.some(NOT_ACCEPTED))
          return
        }
        // Every answer that holds an account is this sheet's ending, whether or not the service
        // took the key: the machine decides, and the row or card that asked says which. A sheet
        // that was closed while the call was out has already ended, and there is nothing left to go
        // back from.
        if (sheet.answered(result.success.connection)) navigation.goBack()
      }),
    )
  }

  return (
    <FittedSheet
      title={`Connect ${name}`}
      detail="This goes straight to the integration and is never shown to Vivid or kept in a thread."
    >
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
      {/* The wrapper adds nothing to the layout: its leaving is how the sheet closing is heard
          (`closing`). An empty view of its own would take a row of the sheet's spacing. */}
      <View ref={closing}>
        <Button
          kind="primary"
          label={busy ? 'One moment…' : 'Connect'}
          disabled={busy || !complete}
          onPress={() => void submit()}
        />
      </View>
    </FittedSheet>
  )
}
