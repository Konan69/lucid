import { GlassView } from 'expo-glass-effect'
import type { ComponentProps, ReactNode } from 'react'
import { StyleSheet } from 'react-native'
import Animated from 'react-native-reanimated'
import { useTheme } from '../theme'
import { cast, lifted } from './elevation'
import { GLASS_SUPPORTED, GlassMaterial } from './Glass'

/** The height of a pill: the one under Vivid's avatar is the same (`ui/Presence.tsx`, `PILL`). */
export const PILL = 30

/** The system's glass as a view Reanimated can move, enter and take away. */
const MovingGlass = Animated.createAnimatedComponent(GlassView)

/**
 * A small glass shape that floats over the foot of a conversation and can be moved: the thinking
 * bubble, and the round button that comes out of its end (`ui/Floating.tsx`). It is as tall as
 * `PILL` and as wide as what it holds, unless its `style` says otherwise.
 *
 * Ported from T3 Code mobile `src/features/threads/floating-working-control.tsx`
 * (`FloatingWorkingControl`), which draws each of its two shapes one of two ways:
 * - Where the system has glass, the shape IS the glass view (`AnimatedGlassView`, `regular`,
 *   `overflow-hidden rounded-full`) and its content is the glass view's child. That is what lets
 *   a `GlassContainer` around two of them run their glass together while they are near, and it
 *   is why the transform is on the glass view itself.
 * - Elsewhere it is a clipped shape over the frosted fill, with the app's ring for an edge.
 *
 * Adaptations, and why:
 * - No tint (`tintColor="transparent"`), a `sm` shadow from `ui/elevation.ts` and a 30-point
 *   height where the reference is 38.5 with a border class: the thinking bubble was drawn this
 *   way before it gained a button (`ui/Thinking.tsx`, the passive `GlassMaterial`), and the owner
 *   asked for its look to stay as it was.
 * - Until 10 October 2026 the bubble was a clipping view with the glass laid behind its content
 *   as a sibling. A glass view wrapped in a clipping view cannot run into its neighbour's, so
 *   where there is glass the bubble is now the glass view itself, as the reference's is.
 *
 * Not seen on an iPhone from here: there is no iOS device or simulator to run it on.
 */
export function Pill({
  interactive,
  style,
  children,
  ...moving
}: Omit<ComponentProps<typeof Animated.View>, 'ref' | 'children'> & {
  children: ReactNode
  /** The shape is itself pressed, so the system's glass answers the finger with its highlight. */
  interactive: boolean
}) {
  const { colors: c, dark } = useTheme()
  const outline = {
    height: PILL,
    borderRadius: PILL / 2,
    borderCurve: 'continuous',
    overflow: 'hidden',
  } as const
  if (GLASS_SUPPORTED) {
    return (
      <MovingGlass
        {...moving}
        glassEffectStyle="regular"
        tintColor="transparent"
        colorScheme={dark ? 'dark' : 'light'}
        isInteractive={interactive}
        // The system's glass has an edge of its own, so the shadow has no ring.
        style={[outline, cast('sm'), style]}
      >
        {children}
      </MovingGlass>
    )
  }
  return (
    // Without the system's glass the ring of the shadow is the shape's edge.
    <Animated.View {...moving} style={[outline, lifted('sm', c.border), style]}>
      <GlassMaterial
        style={[StyleSheet.absoluteFill, { borderRadius: PILL / 2, borderCurve: 'continuous' }]}
      />
      {children}
    </Animated.View>
  )
}
