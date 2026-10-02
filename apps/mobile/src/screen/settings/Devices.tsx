import { Data, Result } from 'effect'
import { useState } from 'react'
import { approveDevice } from '../../data/account'
import { confirm } from '../../data/haptics'
import { useLiveData } from '../../data/live'
import { MOBILE_TYPOGRAPHY } from '../../data/typography'
import { Sheet } from '../../ui/Sheet'
import { Button, Field, Label, Labelled, MONO, Notice } from '../../ui/ui'

/** How the last attempt to let a device in went. */
type Outcome = Data.TaggedEnum<{ Idle: {}; Asking: {}; Paired: {}; Refused: {} }>
const Outcome = Data.taggedEnum<Outcome>()

/**
 * Signing in another phone or the desktop app from this one. The other device shows a short
 * code; entering it here lets that device act as this Person, on this server, without a password
 * leaving either device. Nothing is paired until the code is entered by someone already signed in.
 */
export function Devices({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const [code, setCode] = useState('')
  const [outcome, setOutcome] = useState<Outcome>(Outcome.Idle())

  async function pair() {
    setOutcome(Outcome.Asking())
    const result = await data.run(approveDevice(data.session, code.trim().toUpperCase()))
    if (Result.isFailure(result)) {
      setOutcome(Outcome.Refused())
      return
    }
    confirm()
    setCode('')
    setOutcome(Outcome.Paired())
  }

  return (
    <Sheet
      title="Sign in another device"
      detail="Open Vivid on the other device and choose to sign in with a code. Then enter that code here."
      onClose={onClose}
    >
      <Labelled label="Code from the other device">
        <Field
          autoFocus
          accessibilityLabel="Code from the other device"
          value={code}
          placeholder="ABCD-EFGH"
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="done"
          onChangeText={(next) => {
            setCode(next)
            setOutcome(Outcome.Idle())
          }}
          onSubmitEditing={() => void pair()}
          style={{
            ...MOBILE_TYPOGRAPHY.headline,
            fontFamily: MONO,
            letterSpacing: 2,
          }}
        />
      </Labelled>
      {Outcome.$is('Refused')(outcome) && (
        <Notice message="That code is not waiting, or it ran out. Ask the device for a new one." />
      )}
      {Outcome.$is('Paired')(outcome) && (
        <Label size="label" tone="status-success">
          Done. That device is signed in as you.
        </Label>
      )}
      <Button
        kind="primary"
        label={Outcome.$is('Asking')(outcome) ? 'Signing it in…' : 'Sign it in'}
        disabled={Outcome.$is('Asking')(outcome) || code.trim().length < 4}
        onPress={() => void pair()}
      />
    </Sheet>
  )
}
