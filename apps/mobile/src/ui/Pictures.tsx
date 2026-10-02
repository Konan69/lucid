import { Option } from 'effect'
import { useState } from 'react'
import { Image, ScrollView, View } from 'react-native'
import { tick } from '../data/haptics'
import { useTheme } from '../theme'
import { Sheet } from './Sheet'
import { Label, Press, radius } from './ui'

/** A display or a sent message supplies the same native gallery shape, without invented captions. */
export interface Picture {
  readonly address: string
  readonly caption: Option.Option<string>
}

/**
 * A strip is thumb-scrollable without consuming a whole reply. No zoom/pager library is installed,
 * so tapping opens one full-screen image, fitted completely to the space below the close control.
 */
export function Pictures({ pictures }: { pictures: ReadonlyArray<Picture> }) {
  const { colors: c } = useTheme()
  const [opened, setOpened] = useState<Option.Option<Picture>>(Option.none())
  if (pictures.length === 0) return null
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
      >
        {pictures.map((picture, index) => (
          <View
            // Repeated pictures are allowed; their position is their identity within this strip.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            style={{ width: 128, gap: 4 }}
          >
            <Press
              accessibilityRole="imagebutton"
              accessibilityLabel={Option.getOrElse(
                picture.caption,
                () => `Picture ${index + 1} of ${pictures.length}`,
              )}
              accessibilityHint="Opens full screen"
              onPress={() => {
                tick()
                setOpened(Option.some(picture))
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.82 : 1 })}
            >
              <Image
                source={{ uri: picture.address }}
                resizeMode="cover"
                style={{
                  width: 128,
                  height: 128,
                  borderRadius: radius.control,
                  backgroundColor: c['surface-2'],
                }}
              />
            </Press>
            {Option.isSome(picture.caption) && (
              <Label numberOfLines={1} size="caption" tone="ink-3">
                {picture.caption.value}
              </Label>
            )}
          </View>
        ))}
      </ScrollView>
      {Option.isSome(opened) && (
        <Sheet
          title={Option.getOrUndefined(opened.value.caption)}
          presentation="fullScreen"
          content="fill"
          onClose={() => setOpened(Option.none())}
        >
          <Image
            source={{ uri: opened.value.address }}
            accessibilityLabel={Option.getOrUndefined(opened.value.caption)}
            resizeMode="contain"
            style={{ flex: 1, width: '100%' }}
          />
        </Sheet>
      )}
    </>
  )
}
