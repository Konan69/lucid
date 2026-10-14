import * as lucide from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'

/**
 * A lucide icon, resolved by the name a model writes. The web's vendored `Glyph` loads
 * `lucide-react/dynamic`; lucide's React Native package has no dynamic entry, so the name map is
 * read from the package's own namespace here. "MapPin", "map_pin" and "map pin" all mean the
 * lucide icon "map-pin", as the web's does. An unknown name renders nothing, as the web's does:
 * a missing glyph leaves an empty space in the run, it never breaks the display.
 *
 * The whole package's namespace is in the phone's bundle for this; lucide's glyphs are a few
 * hundred bytes each, and the icon name is model-chosen, so no curated subset can be honest about
 * what the model may name.
 */
const GLYPHS = new Map<string, LucideIcon>(
  Object.entries(lucide as unknown as Record<string, LucideIcon>)
    .filter(([, icon]) => typeof icon === 'function')
    .map(([named, icon]) => [
      named
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .toLowerCase(),
      icon,
    ]),
)

export function glyphOf(value: unknown): LucideIcon | null {
  if (typeof value !== 'string') return null
  const name = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
  return GLYPHS.get(name) ?? null
}
