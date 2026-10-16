import {
  Blocks,
  Brain,
  FolderKanban,
  LibraryBig,
  MessageCircle,
  MessageSquare,
  MonitorSmartphone,
  PanelLeft,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  SquarePen,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Emblem, type Hue } from './Emblem'

/**
 * Every place a Person can go, with the one hue and the one glyph it is known by. It is declared
 * once so the palette, Settings and each screen's own empty state cannot disagree: the Library is
 * violet with its shelf of books wherever it is named, Projects cyan, Integrations green.
 *
 * The glyphs are all lucide, one family at one weight. A place a Person makes things in takes a
 * warm or vivid hue; the places that only adjust Vivid (General, the sidebar) take the grey.
 */
export const PLACES = {
  thread: { hue: 'blue', icon: MessageSquare },
  compose: { hue: 'blue', icon: SquarePen },
  projects: { hue: 'cyan', icon: FolderKanban },
  library: { hue: 'violet', icon: LibraryBig },
  integrations: { hue: 'green', icon: Blocks },
  memory: { hue: 'magenta', icon: Brain },
  people: { hue: 'cyan', icon: Users },
  devices: { hue: 'blue', icon: MonitorSmartphone },
  texting: { hue: 'green', icon: MessageCircle },
  rules: { hue: 'red', icon: ShieldCheck },
  record: { hue: 'brown', icon: ScrollText },
  general: { hue: 'gray', icon: SlidersHorizontal },
  sidebar: { hue: 'gray', icon: PanelLeft },
} satisfies Record<string, { readonly hue: Hue; readonly icon: LucideIcon }>
export type Place = keyof typeof PLACES

/** A place's emblem: its glyph in white on its hue. */
export function PlaceMark({ place, size = 24 }: { place: Place; size?: number }) {
  const { hue, icon: Icon } = PLACES[place]
  return (
    <Emblem hue={hue} size={size}>
      <Icon />
    </Emblem>
  )
}
