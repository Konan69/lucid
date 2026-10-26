import type { Person, PersonSummary } from '@vivid/contracts'
import { Image } from 'expo-image'
import { View } from 'react-native'
import { useTheme } from '../theme'
import { Label } from './ui'

/**
 * A Person as a small round mark: their picture when they have one, otherwise their initial.
 * Decorative, because the name is always written beside it; a screen reader is not told twice.
 */
export function Avatar({
  name,
  image,
  size = 24,
}: {
  name: string
  image: string | null
  size?: number
}) {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c['subtle-strong'],
        borderWidth: 0.5,
        borderColor: c.border,
      }}
    >
      {image === null ? (
        <Label tone="ink-2" style={{ fontSize: Math.round(size * 0.46), lineHeight: size }}>
          {name.trim().charAt(0).toUpperCase()}
        </Label>
      ) : (
        <Image source={{ uri: image }} style={{ width: size, height: size }} />
      )}
    </View>
  )
}

/**
 * The picture on a Person's own record. A summary always says whether there is one; the signed-in
 * Person's record may leave the field out, which means the same thing: no picture.
 */
export const pictureOf = (person: Person): string | null =>
  person.image === undefined ? null : person.image

/**
 * The People in something, overlapped. Shows the first few faces and counts the rest, so a
 * Thread shared with twelve people takes the same room as one shared with three. The names are
 * read out as one label, since the faces themselves say nothing to a screen reader.
 */
export function Faces({
  people,
  size = 18,
  limit = 3,
}: {
  people: ReadonlyArray<PersonSummary>
  size?: number
  limit?: number
}) {
  const shown = people.slice(0, limit)
  const more = people.length - shown.length
  return (
    <View
      accessible
      accessibilityLabel={people.map((person) => person.name).join(', ')}
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      {shown.map((person, place) => (
        <View key={person.id} style={{ marginLeft: place === 0 ? 0 : -5 }}>
          <Avatar name={person.name} image={person.image} size={size} />
        </View>
      ))}
      {more > 0 && (
        <Label size="micro" tone="foreground-tertiary" style={{ marginLeft: 4 }}>
          +{more}
        </Label>
      )}
    </View>
  )
}
