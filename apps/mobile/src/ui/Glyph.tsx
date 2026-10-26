import { SymbolView, type SFSymbol } from 'expo-symbols'
import type { LucideIcon } from 'lucide-react-native'

/**
 * A control's glyph drawn as the system draws its own: an SF Symbol on iOS, at the regular
 * weight, so it has the system's curves and stroke beside system text; elsewhere the matching
 * Lucide glyph at a 1.5 stroke. T3 Code mobile draws its composer controls this way (`SymbolView`
 * with `type="monochrome"` in `ComposerDictationControl.tsx`); Lucide's microphone at a heavier
 * stroke read thick and boxy next to the words (the developer, 26 October 2026).
 */
export function Glyph({
  name,
  fallback: Fallback,
  size,
  color,
}: {
  name: SFSymbol
  fallback: LucideIcon
  size: number
  color: string
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      weight="regular"
      type="monochrome"
      tintColor={color}
      fallback={<Fallback size={size} strokeWidth={1.5} color={color} />}
    />
  )
}
