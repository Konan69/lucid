import { Option } from 'effect'
import { useState } from 'react'
import { commit } from '../../data/haptics'
import { Button, Field } from '../../ui/ui'
import { Asked, Step, useDoorGo } from './Frame'

/** A shape an address can plausibly have; Vivid is the one that decides whether it is real. */
const ADDRESS = /^\S+@\S+\.\S+$/

/**
 * Asks for the Person's email and nothing else. The keyboard's own "next" goes on, as the button
 * does; an address that cannot be one is said under the field once they try to go on, never
 * while they are still typing it.
 */
export function Email() {
  const go = useDoorGo()
  const [email, setEmail] = useState('')
  const [tried, setTried] = useState(false)
  const address = email.trim()
  const fits = ADDRESS.test(address)

  function proceed() {
    if (!fits) {
      commit()
      setTried(true)
      return
    }
    go.navigate('Password', { email: address })
  }

  return (
    <Step
      title="What’s your email?"
      foot={<Button kind="primary" label="Continue" onPress={proceed} />}
    >
      <Asked
        problem={
          tried && !fits ? Option.some('Enter an email like name@example.com.') : Option.none()
        }
      >
        <Field
          autoFocus
          accessibilityLabel="Email"
          value={email}
          placeholder="name@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          returnKeyType="next"
          onChangeText={(next) => {
            setEmail(next)
            setTried(false)
          }}
          onSubmitEditing={proceed}
        />
      </Asked>
    </Step>
  )
}
