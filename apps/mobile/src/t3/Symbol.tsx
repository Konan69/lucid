import { Archive, ArchiveRestore, Trash2 } from 'lucide-react-native'
/** The Lucide glyph standing in for each SF Symbol name the swipe actions ask for. */
const SYMBOL_ICON = {
  trash: Trash2,
  archivebox: Archive,
  'arrow.uturn.backward': ArchiveRestore,
} satisfies Record<'archivebox' | 'arrow.uturn.backward' | 'trash', typeof Archive>

export function SymbolView({
  name,
  size,
  tintColor,
}: {
  name: 'archivebox' | 'arrow.uturn.backward' | 'trash'
  size: number
  tintColor: string
  type?: string
}) {
  const Icon = SYMBOL_ICON[name]
  return <Icon size={size} color={tintColor} strokeWidth={1.6} />
}
