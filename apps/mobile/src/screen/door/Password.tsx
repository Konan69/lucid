import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Option } from 'effect'
import { useState } from 'react'
import { commit } from '../../data/haptics'
import { EmailEntry } from '../../data/signing'
import { Button, Notice } from '../../ui/ui'
import { useAttempt } from './attempt'
import { Asked, Quiet, Step, useServer, type DoorRoutes } from './Frame'
import { Secret } from './Secret'

/**
 * Asks for the password to the email given on the step before. The password is handed to Vivid
 * once and is not kept; what the phone keeps is the session it answers with, and with that the
 * whole door is replaced by the Person's own Home.
 *
 * A wrong password is said under the field. Anything that is not about the password (no
 * connection, too many tries) is said above the button. Nothing typed is cleared.
 *
 * Someone with no account yet goes on from here: "Create an account" carries the same email, so
 * it is not typed twice.
 */
export function Password({ route, navigation }: NativeStackScreenProps<DoorRoutes, 'Password'>) {
  const server = useServer()
  const { email } = route.params
  const [password, setPassword] = useState('')
  const [tried, setTried] = useState(false)
  const attempt = useAttempt()
  const missing = password.length === 0

  function submit() {
    if (attempt.busy) return
    if (missing) {
      commit()
      setTried(true)
      return
    }
    attempt.send(EmailEntry.Enter({ server, email, password }))
  }

  const form = attempt.at('form')
  return (
    <Step
      title="Enter your password"
      lead={email}
      foot={
        <>
          {Option.isSome(form) && <Notice message={form.value} />}
          <Button
            morph
            kind="primary"
            label={attempt.busy ? 'Signing in…' : 'Sign in'}
            disabled={attempt.busy}
            onPress={submit}
          />
          <Quiet
            label="Create an account"
            onPress={() => navigation.navigate('Create', { email })}
          />
        </>
      }
    >
      <Asked
        problem={tried && missing ? Option.some('Enter your password.') : attempt.at('password')}
      >
        <Secret
          autoFocus
          accessibilityLabel="Password"
          value={password}
          placeholder="Password"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onChangeText={(next) => {
            setPassword(next)
            setTried(false)
            attempt.edited()
          }}
          onSubmitEditing={submit}
        />
      </Asked>
    </Step>
  )
}
