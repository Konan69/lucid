import { Archive, ArchiveRestore, Trash2 } from 'lucide-react-native'
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
  const Icon = name === 'trash' ? Trash2 : name === 'archivebox' ? Archive : ArchiveRestore
  return <Icon size={size} color={tintColor} strokeWidth={1.6} />
}
