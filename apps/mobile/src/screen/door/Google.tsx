import { Option } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import Svg, { Path } from 'react-native-svg'
import { Pairing, spellCode, type Ending } from '../../data/device'
import { door, useDoor } from '../../data/door'
import { commit } from '../../data/haptics'
import { googlePairingAtom, reopenGoogleAtom } from '../../data/signing'
import { useTheme } from '../../theme'
import { Button, EDGE, Label, Press } from '../../ui/ui'
import { Spelled } from './Code'
import { Quiet, Step, useServer } from './Frame'

/**
 * Google's "G" as the artwork Google publishes for its sign-in button: four parts on an 18-unit
 * square, each in one of Google's own colours. Its sign-in branding rules ask for this mark,
 * unaltered, beside the words "Continue with Google". The colours are Google's, the same in light
 * and dark, so they are data of the mark and not theme colours. The web welcome draws the same
 * artwork (`apps/web/src/screen/welcome/Google.tsx`).
 */
const G = [
  {
    fill: '#4285F4',
    d: 'M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z',
  },
  {
    fill: '#34A853',
    d: 'M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z',
  },
  {
    fill: '#FBBC05',
    d: 'M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z',
  },
  {
    fill: '#EA4335',
    d: 'M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z',
  },
] as const

/**
 * The second way in, on the first screen: Google's mark and "Continue with Google", on the quiet
 * filled pill an ordinary action is drawn on (`Button`'s `plain`), so "Log in" above it stays the
 * one filled in the primary colour. It is its own control because `Button` takes a single-colour
 * line icon and this mark has four colours of its own.
 *
 * It is 48 points tall, the same as the button above it, and dims under the finger.
 */
export function GoogleButton({ onPress }: { onPress: () => void }) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: 20,
        gap: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 24,
        backgroundColor: c.subtle,
        borderWidth: EDGE,
        borderColor: c.border,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      <Svg width={18} height={18} viewBox="0 0 18 18" pointerEvents="none">
        {G.map((part) => (
          <Path key={part.fill} fill={part.fill} d={part.d} />
        ))}
      </Svg>
      <Label size="footnote" tone="ink" numberOfLines={1} style={{ fontWeight: '600' }}>
        Continue with Google
      </Label>
    </Press>
  )
}

/**
 * What each way the exchange can end means when the Person was signing in with Google. The
 * endings are the code step's own (`Ending`); the words differ because here nobody was asked to
 * type a code, so "this code ran out" would name a thing they never held.
 */
const ENDINGS = {
  unreachable: {
    title: 'Can’t reach Vivid',
    detail: 'Check your connection and try again.',
  },
  expired: {
    title: 'This sign-in ran out',
    detail: 'It waits a few minutes for you to approve this phone. Start again when you are ready.',
  },
  denied: {
    title: 'This phone was not let in',
    detail: 'It was not approved in the browser. Start again to approve it.',
  },
  refused: {
    title: 'Vivid could not start a sign-in',
    detail: 'Try again in a moment.',
  },
} as const satisfies Record<Ending, { title: string; detail: string }>

/**
 * Signing in with Google. The phone cannot show Google's sign-in itself, so it hands the Person to
 * their browser and waits: reading the exchange is what runs it (`googlePairingAtom`), and the
 * exchange opens the browser as soon as it has a code. There the Person signs in with Google and
 * approves this phone; the exchange then adopts the session itself and the whole door is
 * replaced, so there is nothing to do here on success.
 *
 * The one sentence says all of that before the browser covers it. The code is shown too, as on
 * the code step: the approval page shows the same one, which is how a Person knows the phone
 * being let in is this one. The foot opens the browser again, for a Person who came back without
 * finishing.
 */
export function Google() {
  const server = useServer()
  const exchange = googlePairingAtom(server)
  const state = AsyncResult.getOrElse(useDoor(exchange), () => Pairing.Asking())
  const again = () => {
    commit()
    door.refresh(exchange)
  }
  return Pairing.$match(state, {
    Asking: () => (
      <Step title="Continue with Google" lead="Opening your browser…" foot={null}>
        <Spelled code={Option.none()} />
      </Step>
    ),
    Waiting: ({ userCode }) => (
      <Step
        title="Continue with Google"
        lead="Your browser opens. Sign in with Google there, approve this phone, then come back here."
        foot={
          <Quiet
            label="Open the browser again"
            onPress={() => door.set(reopenGoogleAtom, { server, userCode })}
          />
        }
      >
        <Spelled code={Option.some(spellCode(userCode))} />
        <Label accessibilityLiveRegion="polite" size="label" tone="ink-2">
          Waiting for you to approve this phone. The browser shows this code.
        </Label>
      </Step>
    ),
    Approved: () => (
      <Step title="You are in" lead="Opening Vivid…" foot={null}>
        {null}
      </Step>
    ),
    Ended: ({ why }) => (
      <Step
        title={ENDINGS[why].title}
        lead={ENDINGS[why].detail}
        foot={<Button kind="primary" label="Try again" onPress={again} />}
      >
        {null}
      </Step>
    ),
  })
}
