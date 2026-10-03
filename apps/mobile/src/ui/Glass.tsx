import { BlurView } from 'expo-blur'
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from '../theme'

/**
 * Whether this device draws real glass: iOS with the system's glass effect API. Asked once, at
 * load, because the answer cannot change while the app runs. Everywhere else, Android included,
 * glass is a solid bordered surface; nothing is blurred there.
 *
 * Ported from T3 Code mobile `src/native/native-glass.ts` and
 * `src/lib/native-glass-capability.ts` (`supportsNativeLiquidGlass`).
 */
export const GLASS_SUPPORTED = Platform.OS === 'ios' && isGlassEffectAPIAvailable()

/** The radius of a glass surface that states none of its own. */
const RADIUS = 32

/**
 * The frosted fill behind a shape that clips its children. iOS blurs what is under it and lays
 * the theme's `glass-fallback` over the blur; Android, which has no blur here, gets the same
 * colour at full strength so nothing shows through it.
 *
 * Ported from T3 Code mobile `src/components/GlassBackdrop.tsx` (`BlurView` at intensity 80 on
 * iOS only). Its `themeColorWithAlpha(color, 1)` becomes `opaque`: Android paints the theme's
 * solid `screen` instead of rewriting an rgba string at run time.
 */
export function GlassFill({ opaque }: { opaque?: string }) {
  const { colors: c, dark } = useTheme()
  const blurs = Platform.OS === 'ios'
  return (
    <>
      {blurs && (
        <BlurView
          pointerEvents="none"
          intensity={80}
          tint={dark ? 'dark' : 'default'}
          style={StyleSheet.absoluteFill}
        />
      )}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: blurs ? c['glass-fallback'] : (opaque ?? c.screen) },
        ]}
      />
    </>
  )
}

/**
 * Floating chrome: the bar at the top, the composer, a menu, a sheet's handle bar. It is the
 * only place glass is used; content never sits on a blurred card.
 *
 * - `bordered` (the default) has the theme's border and a soft cast shadow, which is what lifts
 *   it off the page.
 * - `bare` has neither, for glass that is already inside a bordered shape.
 *
 * Ported from T3 Code mobile `src/components/GlassSurface.tsx`: `GlassView` where the system has
 * glass, else a bordered surface over `GlassFill`; radius 32; shadow opacity 0.22 in dark and
 * 0.08 in light, radius 28, offset 14 down, elevation 12; its `chrome="none"` is `bare` here.
 * As there, Android casts no shadow: its elevation shadow cannot be tinted or softened and reads
 * as a dirty edge under a translucent fill.
 */
export function Glass({
  children,
  chrome = 'bordered',
  radius = RADIUS,
  style,
}: {
  children: ReactNode
  chrome?: 'bordered' | 'bare'
  radius?: number
  style?: StyleProp<ViewStyle>
}) {
  const { colors: c, dark } = useTheme()
  const lifted = chrome === 'bordered' && Platform.OS !== 'android'
  const outline: ViewStyle = {
    borderRadius: radius,
    borderCurve: 'continuous',
    borderWidth: chrome === 'bordered' ? 1 : 0,
    borderColor: c.border,
    shadowColor: '#000000',
    shadowOpacity: lifted ? (dark ? 0.22 : 0.08) : 0,
    shadowRadius: lifted ? 28 : 0,
    shadowOffset: { width: 0, height: lifted ? 14 : 0 },
  }
  if (GLASS_SUPPORTED) {
    return (
      <GlassView
        glassEffectStyle="regular"
        tintColor={c['glass-tint']}
        colorScheme={dark ? 'dark' : 'light'}
        style={[outline, { overflow: 'hidden', backgroundColor: c['glass-surface'] }, style]}
      >
        {children}
      </GlassView>
    )
  }
  return (
    <View style={[outline, { overflow: 'hidden' }, style]}>
      <GlassFill opaque={c['card-alt']} />
      {children}
    </View>
  )
}
