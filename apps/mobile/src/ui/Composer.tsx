import { useState, type Ref } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, Square } from 'lucide-react-native'
import { commit } from '../data/haptics'
import { useKeyboardShowing } from '../data/keyboard'
import { MOBILE_TYPOGRAPHY } from '../data/typography'
import { ComposerEditor } from '../native/composer/Editor'
import type { ComposerEditorHandle } from '../native/composer/types'
import { useTheme } from '../theme'
import { HAIRLINE, Press, styles, TARGET } from './ui'

/**
 * The editor's height: one line with its inset is exactly the send button's 34 points, so a
 * single line and the button share a centre. It grows to six lines, then scrolls inside itself.
 */
const LINE = MOBILE_TYPOGRAPHY.reading.lineHeight
const INSET = 5
const SHORTEST = LINE + INSET * 2
const TALLEST = LINE * 6 + INSET * 2

/**
 * Where a Person writes to Vivid: on the first screen to start a Thread, and in a Thread to
 * speak in it. The text is owned by the screen (a suggestion can fill it, a failed send keeps
 * it); this draws the field and the one button beside it.
 *
 * The button is always the same place and size. It sends; while Vivid is working it becomes the
 * way to stop, which is the only moment a Person wants that and exactly where their thumb is.
 *
 * It rests on the home indicator's inset when the keyboard is down and directly on the keyboard
 * when it is up. The screen around it moves it there (`KeyboardAvoidingView`); nothing here
 * animates.
 */
export function Composer({
  ref,
  value,
  placeholder,
  working,
  disabled,
  onChange,
  onSend,
  onStop,
}: {
  ref?: Ref<ComposerEditorHandle>
  value: string
  placeholder: string
  /** Vivid is in the middle of a Run here, so the button stops instead of sending. */
  working: boolean
  /** A send is already on its way, so another cannot start. */
  disabled: boolean
  onChange: (text: string) => void
  onSend: () => void
  onStop: () => void
}) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardShowing()
  const [height, setHeight] = useState(SHORTEST)
  const empty = value.trim().length === 0
  const idle = !working && (disabled || empty)

  function send() {
    if (idle) return
    commit()
    if (working) onStop()
    else onSend()
  }

  return (
    <View
      style={{
        // Opaque, so nothing the list above draws can show through its padding.
        backgroundColor: c['surface-0'],
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 12),
      }}
    >
      <View
        style={[
          styles.column,
          {
            flexDirection: 'row',
            alignItems: 'flex-end',
            paddingLeft: 16,
            paddingRight: 5,
            paddingVertical: 5,
            // The round button inside is 34 points with 5 around it: 22 is concentric with it.
            borderRadius: 22,
            backgroundColor: c['surface-2'],
            borderWidth: HAIRLINE,
            borderColor: c['line-3'],
          },
        ]}
      >
        <ComposerEditor
          ref={ref}
          value={value}
          placeholder={placeholder}
          multiline
          onChangeText={onChange}
          onSubmit={send}
          contentInsetVertical={INSET}
          onContentHeightChange={(next) => setHeight(Math.min(TALLEST, Math.max(SHORTEST, next)))}
          style={{ flex: 1, height }}
          textStyle={MOBILE_TYPOGRAPHY.reading}
        />
        <Press
          accessibilityRole="button"
          accessibilityLabel={working ? 'Stop Vivid' : 'Send'}
          accessibilityState={{ disabled: idle }}
          disabled={idle}
          // The drawn circle is 34 points; the slop makes what a thumb hits the full 44.
          hitSlop={(TARGET - 34) / 2}
          onPress={send}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: working ? c['status-danger'] : c.accent,
            opacity: idle ? 0.35 : 1,
          }}
        >
          {working ? (
            <Square
              pointerEvents="none"
              size={13}
              color={c['ink-on-accent']}
              fill={c['ink-on-accent']}
            />
          ) : (
            <ArrowUp pointerEvents="none" size={19} strokeWidth={2} color={c['ink-on-accent']} />
          )}
        </Press>
      </View>
    </View>
  )
}
