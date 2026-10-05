import { Workspace, type MeResponse } from '@vivid/contracts'
import { greetingAt } from '@vivid/state'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNow } from '../../data/foreground'
import { APPEAR } from '../../ui/motion/morph'
import { Face, Label } from '../../ui/ui'

/** The Person's first name, when their name has one to take. */
const firstName = (me: MeResponse): string => me.person.name.trim().split(/\s+/u, 1).join('')

/**
 * The inset of everything written on this screen. The composer under it is 12 points from the
 * glass with 16 of padding inside, so its words start at 28; the greeting starts there too, and
 * the screen reads as one column down to the keyboard.
 */
const INSET = 28

/**
 * Home's whole content for someone Vivid has met: a greeting for the hour and one question. There
 * is nothing to set up and nothing to choose; the composer under it is the only thing to do.
 *
 * Someone Vivid has not met never sees it. The server opens their first Thread and Vivid speaks
 * first there, for real (`data/arrival.ts`); until that Thread is open Home is `Waiting`. This
 * greeting is what Home is afterwards, and what it is if that Thread could not be opened.
 *
 * It is type alone. Vivid's face is in its capsule at the top of this screen, beside its name
 * (`ui/Presence.tsx`), so a second, larger face here would be decoration; the light it used to
 * sit in is gone for the same reason. Suggestion cards were removed by the owner on 3 October
 * 2026.
 *
 * Nothing here moves: the screen is drawn whole.
 */
export function First({ me }: { me: MeResponse }) {
  const name = firstName(me)
  // The hour is the one the app was last brought to the front in, not a ticking clock: a greeting
  // that changed under someone reading it would be a glitch, and one left open overnight should
  // not still say "Evening" when the phone is picked up in the morning.
  const hello = greetingAt(new Date(useNow()).getHours())
  return (
    <View style={{ paddingHorizontal: INSET, paddingBottom: 14 }}>
      <Label accessibilityRole="header" size="opening">
        {name.length === 0 ? `${hello}.` : `${hello}, ${name}.`}
      </Label>
      <Label size="title" tone="ink-2" style={{ marginTop: 6, fontWeight: '400' }}>
        {Workspace.match(me.workspace, {
          Personal: () => 'What should I take off your plate?',
          Company: ({ company }) => `What should I take off your plate at ${company.name}?`,
        })}
      </Label>
    </View>
  )
}

/**
 * About the room the composer takes at the foot of Home, without the safe area under it. The
 * waiting face is centred in what is left above it, so it stands where the eye already is when
 * the Thread opens and not in the middle of the bare glass.
 */
const COMPOSER_ROOM = 64

/**
 * Home while a Person's first Thread is being opened: Vivid's face alone, thinking. There is no
 * greeting and nowhere to type, because Vivid is about to speak first and anything typed here
 * would start a second Thread beside the one being opened.
 *
 * It is the face the app shows while it connects (`App.tsx`), at the same size, so launching into
 * a first arrival reads as one wait and not two screens. The face fades in once and nothing else
 * moves; with reduced motion it is simply there.
 */
export function Waiting() {
  const insets = useSafeAreaInsets()
  return (
    <View
      // One thing to a screen reader: that the app is busy, not a picture inside a container.
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: insets.bottom + COMPOSER_ROOM,
      }}
    >
      <Animated.View entering={APPEAR}>
        <Face size={44} mood="thinking" />
      </Animated.View>
    </View>
  )
}
