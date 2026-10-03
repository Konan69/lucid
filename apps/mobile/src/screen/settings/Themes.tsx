import { nativeThemes } from '@vivid/tokens/native'
import { View } from 'react-native'
import {
  FAMILIES,
  FAMILY_NAME,
  familyAtom,
  followFamilyAtom,
  type Family,
} from '../../data/appearance'
import { door, useDoor } from '../../data/door'
import { tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { EDGE, Label, Press } from '../../ui/ui'

/** The swatch's diameter. With its name under it, four fit across the narrowest phone. */
const SWATCH = 56

/**
 * One family as a small picture of itself: its canvas, its user bubble and its primary, in the
 * appearance (light or dark) the phone is showing now. It is flat colour, so what the Person
 * sees in the swatch is exactly what the app will be painted in.
 *
 * The reference draws a gradient orb here (T3 Code mobile
 * `src/features/settings/appearance/sections/ThemeAppearanceSection.tsx`, `PreviewOrb`); Vivid
 * keeps the picker's shape (a row of round previews, one chosen) and drops the gradient.
 */
function Swatch({ family, chosen }: { family: Family; chosen: boolean }) {
  const { colors: c, dark } = useTheme()
  const preview = nativeThemes[family][dark ? 'dark' : 'light']
  return (
    <View
      style={{
        width: SWATCH + 8,
        height: SWATCH + 8,
        borderRadius: (SWATCH + 8) / 2,
        alignItems: 'center',
        justifyContent: 'center',
        // The ring that says "this one", in the family now in force, outside the preview itself.
        borderWidth: 2,
        borderColor: chosen ? c.primary : 'transparent',
      }}
    >
      <View
        style={{
          width: SWATCH,
          height: SWATCH,
          borderRadius: SWATCH / 2,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          backgroundColor: preview.screen,
          borderWidth: EDGE,
          borderColor: preview.border,
        }}
      >
        <View
          style={{ width: 26, height: 9, borderRadius: 5, backgroundColor: preview['user-bubble'] }}
        />
        <View
          style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: preview.primary }}
        />
      </View>
    </View>
  )
}

/**
 * The theme families, side by side, one chosen. Choosing paints the whole app at once; the choice
 * is this phone's and is kept on it (`data/appearance.ts`).
 */
export function Themes() {
  const current = useDoor(familyAtom)
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Theme"
      style={{ flexDirection: 'row', justifyContent: 'space-between' }}
    >
      {FAMILIES.map((family) => {
        const chosen = family === current
        return (
          <Press
            key={family}
            accessibilityRole="radio"
            accessibilityLabel={FAMILY_NAME[family]}
            accessibilityState={{ selected: chosen }}
            onPress={() => {
              if (chosen) return
              tick()
              door.set(followFamilyAtom, family)
            }}
            style={({ pressed }) => ({ alignItems: 'center', gap: 6, opacity: pressed ? 0.7 : 1 })}
          >
            <Swatch family={family} chosen={chosen} />
            <Label size="caption" tone={chosen ? 'ink' : 'ink-2'}>
              {FAMILY_NAME[family]}
            </Label>
          </Press>
        )
      })}
    </View>
  )
}
