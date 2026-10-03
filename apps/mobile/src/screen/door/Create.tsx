import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Option } from 'effect'
import { useRef, useState } from 'react'
import type { TextInput } from 'react-native'
import { commit } from '../../data/haptics'
import { EmailEntry } from '../../data/signing'
import { Button, Field, Notice } from '../../ui/ui'
import { useAttempt } from './attempt'
import { Asked, Step, useServer, type DoorRoutes } from './Frame'
import { Secret } from './Secret'

/** The least a new password can be. Vivid enforces it too; saying it first saves a round trip. */
const SHORTEST = 8

/**
 * A new account, for the email already given: a name and a password, nothing more. The account is
 * signed in the moment it is made, so there is no second sign-in and no "check your email" step
 * between a Person and their first Thread.
 *
 * The name's "next" key moves to the password; the password's "go" key creates the account.
 */
export function Create({ route }: NativeStackScreenProps<DoorRoutes, 'Create'>) {
  const server = useServer()
  const { email } = route.params
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [tried, setTried] = useState(false)
  const secret = useRef<TextInput>(null)
  const attempt = useAttempt()
  const nameless = name.trim().length === 0
  const short = password.length < SHORTEST

  function submit() {
    if (attempt.busy) return
    if (nameless || short) {
      commit()
      setTried(true)
      return
    }
    attempt.send(EmailEntry.Create({ server, name: name.trim(), email, password }))
  }

  // Either failure can only be about the whole request here: this step has no email field for
  // "already has an account" to sit under, and a new password cannot be the wrong one.
  const refused = Option.orElse(attempt.at('form'), () => attempt.at('password'))
  return (
    <Step
      title="Create your account"
      lead={email}
      foot={
        <>
          {Option.isSome(refused) && <Notice message={refused.value} />}
          <Button
            morph
            kind="primary"
            label={attempt.busy ? 'Creating your account…' : 'Create account'}
            disabled={attempt.busy}
            onPress={submit}
          />
        </>
      }
    >
      <Asked problem={tried && nameless ? Option.some('Enter your name.') : Option.none()}>
        <Field
          autoFocus
          accessibilityLabel="Your name"
          value={name}
          placeholder="Your name"
          autoComplete="name"
          textContentType="name"
          autoCapitalize="words"
          returnKeyType="next"
          submitBehavior="submit"
          onChangeText={(next) => {
            setName(next)
            attempt.edited()
          }}
          onSubmitEditing={() => {
            if (secret.current !== null) secret.current.focus()
          }}
        />
      </Asked>
      <Asked problem={tried && short ? Option.some('Use at least 8 characters.') : Option.none()}>
        <Secret
          ref={secret}
          accessibilityLabel="Password"
          value={password}
          placeholder="Password, at least 8 characters"
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onChangeText={(next) => {
            setPassword(next)
            attempt.edited()
          }}
          onSubmitEditing={submit}
        />
      </Asked>
    </Step>
  )
}
