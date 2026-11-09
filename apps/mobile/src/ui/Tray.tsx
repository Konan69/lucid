import { attaching } from '@vivid/state'
import { FileText, X } from 'lucide-react-native'
import { ActivityIndicator, Image, ScrollView, View } from 'react-native'
import { useTheme } from '../theme'
import { Label, Press } from './ui'

/** A file's tile: square for a picture, as tall as one for a document's chip. */
const TILE = 56
/** The round button that takes a file off, sitting over the tile's corner. */
const OFF = 20

/**
 * The files going with the message being written, along the top of the composer: a picture as
 * its own thumbnail, a document as a chip with its name, one being read or sent with a spinner,
 * and one that cannot go with why. Each comes off with the round button on its corner, except the
 * one being read or sent, which the machine will not take off until it is done (`attaching`).
 *
 * The look is the mockup agreed on 26 October 2026: thumbnails inside the composer above the
 * words, removable before sending, as Messages and T3 Code mobile show attachments.
 */
export function Tray({
  tray,
  onRemove,
}: {
  tray: attaching.Tray
  onRemove: (key: string) => void
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 2 }}
    >
      {tray.items.map((item) => (
        <Tile
          key={item.file.key}
          item={item}
          removable={!attaching.Item.guards.Waiting(item) || !tray.preparing}
          onRemove={() => onRemove(item.file.key)}
        />
      ))}
    </ScrollView>
  )
}

function Tile({
  item,
  removable,
  onRemove,
}: {
  item: attaching.Item
  removable: boolean
  onRemove: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <View style={{ paddingTop: OFF / 3, paddingRight: OFF / 3 }}>
      <Face item={item} />
      {removable && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.file.name}`}
          onPress={onRemove}
          hitSlop={10}
          style={({ pressed }) => ({
            position: 'absolute',
            top: 0,
            right: 0,
            width: OFF,
            height: OFF,
            borderRadius: OFF / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.foreground,
            opacity: pressed ? 0.7 : 1,
            borderWidth: 2,
            borderColor: c.screen,
          })}
        >
          <X size={11} strokeWidth={2.6} color={c.screen} />
        </Press>
      )}
    </View>
  )
}

/** What a tile shows for its file: a thumbnail for a picture, a chip for everything else. */
function Face({ item }: { item: attaching.Item }) {
  const { colors: c } = useTheme()
  if (attaching.Item.guards.Picture(item))
    return (
      <Image
        accessibilityLabel={item.file.name}
        source={{ uri: item.file.uri }}
        style={{ width: TILE, height: TILE, borderRadius: 12, backgroundColor: c['surface-well'] }}
      />
    )
  return <Chip {...chipOf(item)} />
}

/** The chip's words for a file that is not a kept picture. */
const chipOf = (item: attaching.Item) =>
  attaching.Item.match(item, {
    Refused: ({ file, why }) => ({ name: file.name, detail: why, busy: false, refused: true }),
    Waiting: ({ file }) => ({
      name: file.name,
      detail: file.mimeType.startsWith('image/') ? 'Reading…' : 'Sending…',
      busy: true,
      refused: false,
    }),
    Document: ({ file }) => ({
      name: file.name,
      detail: 'In your Library',
      busy: false,
      refused: false,
    }),
    // A kept picture shows as its thumbnail (`Face`); this is its chip if one is ever needed.
    Picture: ({ file }) => ({ name: file.name, detail: 'Picture', busy: false, refused: false }),
  })

/** A document, or a file on its way or refused: its kind, its name and where it stands. */
function Chip({
  name,
  detail,
  busy,
  refused,
}: {
  name: string
  detail: string
  busy: boolean
  refused: boolean
}) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        height: TILE,
        maxWidth: 200,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        borderCurve: 'continuous',
        backgroundColor: c['surface-well'],
        borderWidth: refused ? 1 : 0,
        borderColor: c['status-danger'],
      }}
    >
      <View
        style={{
          width: 28,
          height: 34,
          borderRadius: 6,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: refused ? c['status-danger'] : c.primary,
        }}
      >
        {busy ? (
          <ActivityIndicator size="small" color={c['primary-foreground']} />
        ) : (
          <FileText size={15} strokeWidth={2} color={c['primary-foreground']} />
        )}
      </View>
      <View style={{ flexShrink: 1 }}>
        <Label size="footnote" numberOfLines={1} style={{ fontWeight: '600' }}>
          {name}
        </Label>
        <Label size="caption" tone={refused ? 'status-danger' : 'ink-2'} numberOfLines={2}>
          {detail}
        </Label>
      </View>
    </View>
  )
}
