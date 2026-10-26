import { Data, Option } from 'effect'
import { useState } from 'react'
import { Image } from 'expo-image'
import { View } from 'react-native'
import type { MessagePicture } from '../../data/message'
import { useTheme } from '../../theme'
import { Avatar } from '../../ui/Avatar'
import { Sheet } from '../../ui/Sheet'
import { EDGE, Label, Press, radius } from '../../ui/ui'

/**
 * Whose words a bubble holds, which is all that decides how it is drawn.
 *
 * - `Mine`: the reader's own, and with Vivid: a message they typed, or their answer to a question
 *   of Vivid's (`Replied`, `Question.tsx`). The one filled shape in a Thread.
 * - `Unsent`: the reader's own that did not arrive: an outline where a sent message is filled.
 * - `Theirs`: someone else's in a shared Thread, under their name when the server gave one.
 */
export type Voice = Data.TaggedEnum<{
  Mine: {}
  Unsent: {}
  Theirs: { readonly name: Option.Option<string> }
}>
export const Voice = Data.taggedEnum<Voice>()

/** The corner a bubble squares off: the one nearest whoever said it. */
const TAIL = 6

/**
 * A Person's words. The reader's own sit on the right, filled in the theme's `user-bubble` with the corner
 * nearest the composer squared off: in a Thread that is mostly Vivid's plain text, the Person's
 * words are the one filled shape, found at a glance. Words that did not arrive keep their place
 * and their shape but are only an outline, dashed, so nothing unsent is ever mistaken for said;
 * the way to send them again is at the foot of the conversation.
 *
 * Someone else's sit on the left on the neutral surface, under their name; a message the server
 * delivered without a name is drawn without one, never with an invented one.
 *
 * The reader's own bubble has the same one-point edge sent or not (on the filled one it is the
 * fill's own colour), so a message that is sent again does not move when it stops being an
 * outline.
 */
export function Said({
  text,
  voice,
  pictures,
}: {
  text: string
  voice: Voice
  pictures: ReadonlyArray<MessagePicture>
}) {
  const { colors: c } = useTheme()
  const paint = Voice.$match(voice, {
    Mine: () =>
      ({
        fill: c['user-bubble'],
        edge: c['user-bubble'],
        line: 1,
        ink: 'user-bubble-foreground',
      }) as const,
    Unsent: () => ({ fill: 'transparent', edge: c.border, line: 1, ink: 'ink-2' }) as const,
    Theirs: () => ({ fill: c.subtle, edge: c.border, line: EDGE, ink: 'ink' }) as const,
  })
  const unsent = Voice.$is('Unsent')(voice)
  const from = Voice.$is('Theirs')(voice) ? voice.name : Option.none<string>()
  const mine = !Voice.$is('Theirs')(voice)
  return (
    <View
      style={{ flexDirection: 'row', gap: 10, justifyContent: mine ? 'flex-end' : 'flex-start' }}
    >
      {Option.isSome(from) && (
        <View style={{ marginTop: 20 }}>
          <Avatar name={from.value} image={null} size={24} />
        </View>
      )}
      <View style={{ flexShrink: 1, maxWidth: '84%', gap: 4 }}>
        {Option.isSome(from) && (
          <Label size="caption" tone="ink-2" style={{ marginLeft: 4 }}>
            {from.value}
          </Label>
        )}
        <View
          // A screen reader cannot see an outline; it is told the words did not go.
          accessibilityHint={unsent ? 'Not sent' : undefined}
          style={{
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: radius.panel,
            borderBottomRightRadius: mine ? TAIL : radius.panel,
            borderTopLeftRadius: mine ? radius.panel : TAIL,
            backgroundColor: paint.fill,
            borderWidth: paint.line,
            borderStyle: unsent ? 'dashed' : 'solid',
            borderColor: paint.edge,
          }}
        >
          <Pictures pictures={pictures} />
          <Label selectable size="reading" tone={paint.ink}>
            {text}
          </Label>
        </View>
      </View>
    </View>
  )
}

/** A sent picture opens at full size, using the native sheet in place of the web's image link. */
function Pictures({ pictures }: { pictures: ReadonlyArray<MessagePicture> }) {
  const [opened, setOpened] = useState<Option.Option<MessagePicture>>(Option.none())
  if (pictures.length === 0) return null
  // One picture is the point of the message and is drawn large; several are a tidy grid.
  const side = pictures.length === 1 ? 216 : 104
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {pictures.map((picture, index) => (
          <Press
            key={picture.key}
            accessibilityRole="imagebutton"
            accessibilityLabel={Option.getOrElse(
              picture.name,
              () => `Picture ${index + 1} of ${pictures.length}`,
            )}
            accessibilityHint="Opens full size"
            onPress={() => setOpened(Option.some(picture))}
            style={({ pressed }) => ({ opacity: pressed ? 0.82 : 1 })}
          >
            <Image
              source={{ uri: picture.url }}
              contentFit="cover"
              style={{ width: side, height: side, borderRadius: radius.row }}
            />
          </Press>
        ))}
      </View>
      {Option.isSome(opened) && (
        <Sheet
          title={Option.getOrUndefined(opened.value.name)}
          onClose={() => setOpened(Option.none())}
        >
          <Image
            source={{ uri: opened.value.url }}
            accessibilityLabel={Option.getOrUndefined(opened.value.name)}
            contentFit="contain"
            style={{ width: '100%', aspectRatio: 1 }}
          />
        </Sheet>
      )}
    </>
  )
}
