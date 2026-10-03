import { Easing, FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated'

/**
 * How a control changes shape. A control that grows, shrinks or moves does it as one layout
 * transition on the UI thread; nothing is measured in JavaScript and nothing repaints while it
 * rests. Every preset honours the system's reduced-motion setting, where the new shape is simply
 * drawn.
 *
 * Ported from T3 Code mobile, timings unchanged:
 * - `MORPH`: `src/components/SegmentedControl.tsx` (`LinearTransition.duration(200)` with
 *   `Easing.out(Easing.cubic)`), also the composer's `DICTATION_LAYOUT` family in
 *   `src/features/voice-input/ComposerDictationControl.tsx`.
 * - `ROW_MORPH`, `APPEAR`, `LEAVE`: `src/features/connection/ConnectionEnvironmentRow.tsx`
 *   (`LinearTransition.duration(250)`, `FadeIn.duration(200)`, `FadeOut.duration(150)`).
 * - `MENU_APPEAR`: `src/components/AndroidAnchoredMenu.tsx` (`FadeIn.duration(120)`).
 */

/** A control whose own outline changes: a segment's thumb, a button that gains a label. */
export const MORPH = LinearTransition.duration(200)
  .easing(Easing.out(Easing.cubic))
  .reduceMotion(ReduceMotion.System)

/** A row or group that makes room for something appearing inside it. */
export const ROW_MORPH = LinearTransition.duration(250).reduceMotion(ReduceMotion.System)

/** What arrives inside a control that has changed shape. */
export const APPEAR = FadeIn.duration(200).reduceMotion(ReduceMotion.System)

/** What leaves it: quicker than it arrived, so the control is never waiting on something going. */
export const LEAVE = FadeOut.duration(150).reduceMotion(ReduceMotion.System)

/** A menu or popover: it is asked for, so it is there almost at once. */
export const MENU_APPEAR = FadeIn.duration(120).reduceMotion(ReduceMotion.System)
