import { Option } from 'effect'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { door, useDoor } from '../../data/door'
import { forgetAtom, forgettingAtom } from '../../data/held'
import { Forgetting } from '../../data/session'
import { Button, Face, GUTTER, Label, Notice } from '../../ui/ui'
import { Quiet, useDoorGo, useEntrance } from './Frame'
import { GoogleButton } from './Google'

/**
 * Said when this phone signed out and its store would not drop the saved sign-in (`makeCustody`).
 *
 * The app is signed out either way. What is left is a store that still holds the token, which the
 * next launch would read and sign the Person back in with, so they are told and given the way to
 * try again. It is drawn only once the store has actually refused.
 */
function Unforgotten() {
  const forgetting = useDoor(forgettingAtom)
  const trying = useDoor(forgetAtom).waiting
  if (!Forgetting.$is('Refused')(forgetting)) return null
  return (
    <View style={{ gap: 8 }}>
      <Notice message="You are signed out, but this phone could not remove its saved sign-in. Until it does, Vivid may open signed in again." />
      <Button
        morph
        label={trying ? 'Trying…' : 'Try again'}
        disabled={trying}
        onPress={() => door.set(forgetAtom, undefined)}
        containerStyle={{ alignSelf: 'flex-start' }}
      />
    </View>
  )
}

/**
 * The first thing a Person sees: Vivid, one line of what it is, and the two ways in: their email,
 * or Google. Vivid is present here, so its face is; nothing else is on the screen.
 *
 * When a session was ended elsewhere, the one sentence that says so is here (`useEntrance`), so
 * a Person who is put back at the door knows why.
 */
export function Welcome() {
  const go = useDoorGo()
  const { ended } = useEntrance()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        flex: 1,
        paddingHorizontal: GUTTER,
        paddingTop: insets.top + 24,
        paddingBottom: Math.max(insets.bottom, 12),
      }}
    >
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          maxWidth: 440,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        <Face size={72} mood="happy" />
        <Label accessibilityRole="header" size="opening" style={{ marginTop: 28 }}>
          Vivid is your personal assistant.
        </Label>
      </View>
      <View style={{ maxWidth: 440, width: '100%', alignSelf: 'center', gap: 10 }}>
        {Option.isSome(ended) && <Notice message={ended.value} />}
        <Unforgotten />
        <Button kind="primary" label="Log in" onPress={() => go.navigate('Email')} />
        <GoogleButton onPress={() => go.navigate('Google')} />
        {__DEV__ && (
          <Quiet label="Developer: change address" onPress={() => go.navigate('Address')} />
        )}
      </View>
    </View>
  )
}
