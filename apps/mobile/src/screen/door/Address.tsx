import { Option, Result } from 'effect'
import { useState } from 'react'
import { attemptOf, door, useDoor } from '../../data/door'
import { adoptAtom } from '../../data/held'
import { parseServer } from '../../data/server'
import { Session } from '../../data/session'
import { Button, Field } from '../../ui/ui'
import { Asked, Step } from './Frame'

/**
 * Where this phone's Vivid is, for a developer. A Person never sees this: a release build is
 * given its address when it is built (`data/origin.ts`). A development build is pointed at
 * whatever machine is running Vivid today, so it can be said here.
 *
 * The address is read strictly (`parseServer`): a session token is later sent to whatever is
 * accepted, so a typo is refused with a sentence rather than guessed at. Saving it is one write
 * to the session, which draws the door again against the new address.
 */
export function Address() {
  const [text, setText] = useState('')
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const saving = attemptOf(useDoor(adoptAtom))

  function save() {
    const parsed = parseServer(text)
    if (Result.isFailure(parsed)) {
      setRefused(Option.some(parsed.failure.message))
      return
    }
    setRefused(Option.none())
    door.set(adoptAtom, Session.SignedOut({ server: parsed.success }))
  }

  return (
    <Step
      title="Developer address"
      lead="Development builds only. Which Vivid should this phone open?"
      foot={
        <Button
          kind="primary"
          label="Use this address"
          disabled={saving.busy || text.trim().length === 0}
          onPress={save}
        />
      }
    >
      <Asked problem={Option.orElse(refused, () => saving.refusal)}>
        <Field
          autoFocus
          accessibilityLabel="Address"
          value={text}
          placeholder="http://192.168.1.20:5178"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          returnKeyType="go"
          onChangeText={(next) => {
            setText(next)
            setRefused(Option.none())
          }}
          onSubmitEditing={save}
        />
      </Asked>
    </Step>
  )
}
