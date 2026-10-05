import Animated from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import { useTheme } from '../../theme'
import { APPEAR, LEAVE, MORPH } from '../../ui/motion/morph'
import { EDGE, Label, Press } from '../../ui/ui'

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
 *
 * `busy` is a code being traded for a session, the moment after the browser hands the Person
 * back. The button then cannot be pressed, and its words say what is happening in the quieter
 * ink, fading in over the old ones as `Button`'s `morph` does. The mark is Google's and stays
 * exactly as it is in both states: the words carry the change.
 */
export function GoogleButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  const { colors: c } = useTheme()
  const label = busy ? 'Signing in…' : 'Continue with Google'
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      layout={MORPH}
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
      {/* Keyed by its words, so new words are a new view: the old fade out as these fade in. */}
      <Animated.View key={label} entering={APPEAR} exiting={LEAVE}>
        <Label
          size="footnote"
          tone={busy ? 'ink-2' : 'ink'}
          numberOfLines={1}
          style={{ fontWeight: '600' }}
        >
          {label}
        </Label>
      </Animated.View>
    </Press>
  )
}
