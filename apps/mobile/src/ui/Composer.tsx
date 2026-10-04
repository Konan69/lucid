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
import { BorderBeam } from '../../vendor/beam'
import Animated from 'react-native-reanimated'
import { Glass } from './Glass'
import { APPEAR, LEAVE, MORPH } from './motion/morph'
import { Press, styles, TARGET } from './ui'

/**
 * The editor's height: one line with its inset is exactly the send button's 34 points, so a
 * single line and the button share a centre. It grows to six lines, then scrolls inside itself.
 */
const LINE = MOBILE_TYPOGRAPHY.reading.lineHeight
const INSET = 5
const SHORTEST = LINE + INSET * 2
const TALLEST = LINE * 6 + INSET * 2

/** The pill's corner, shared by the glass and the beam that travels its edge. */
const RADIUS = 23

/**
 * Where a Person writes to Vivid: on the first screen to start a Thread, and in a Thread to
 * speak in it. The text is owned by the screen (a suggestion can fill it, a failed send keeps
 * it); this draws the field and the one button beside it.
 *
 * It is floating glass (`Glass`): a bordered pill lifted off the page, the one piece of chrome at
 * the foot of a screen.
 *
 * It changes shape with what there is to do. With nothing typed there is no button and the field
 * has the whole pill. Once there are words the send button fades in at the end and the field
 * gives it room; while a send is on its way it stays, dimmed; while Vivid is working it is the
 * way to stop, in the same place, which is exactly where the thumb is. The row is a layout
 * transition and the button an enter and exit, with the timings of T3 Code mobile's composer
 * toolbar (`src/features/voice-input/ComposerDictationControl.tsx`, `DICTATION_LAYOUT`), kept in
 * `ui/motion/morph.ts`. The native editor is not animated: it takes its new width at once.
 *
 * It rests on the home indicator's inset when the keyboard is down and directly on the keyboard
 * when it is up. The screen around it moves it there (`KeyboardAvoidingView`).
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
  const { colors: c, dark } = useTheme()
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

  // There is something to press: words to send, or a Run to stop.
  const offered = working || !empty

  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 12),
      }}
    >
      {/* While Vivid is working, a beam travels the pill's edge: the same one, with the same
          colours and strength, as the web composer (`apps/web/src/screen/thread/Composer.tsx`).
          It is drawn only then; at rest nothing repaints. */}
      <BorderBeam
        active={working}
        colorVariant="ocean"
        strength={0.7}
        theme={dark ? 'dark' : 'light'}
        borderRadius={RADIUS}
        style={styles.column}
      >
        {/* The round button inside is 34 points with 6 around it: 23 is concentric with it. */}
        <Glass radius={RADIUS} style={styles.column}>
          <Animated.View
            layout={MORPH}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              paddingLeft: 18,
              paddingRight: 6,
              paddingVertical: 6,
              backgroundColor: c['composer-surface'],
            }}
          >
            <ComposerEditor
              ref={ref}
              value={value}
              placeholder={placeholder}
              multiline
              onChangeText={onChange}
              onSubmit={send}
              contentInsetVertical={INSET}
              onContentHeightChange={(next) =>
                setHeight(Math.min(TALLEST, Math.max(SHORTEST, next)))
              }
              style={{ flex: 1, height }}
              textStyle={MOBILE_TYPOGRAPHY.reading}
            />
            {offered && (
              <Animated.View entering={APPEAR} exiting={LEAVE}>
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
                    backgroundColor: working ? c['status-danger'] : c.primary,
                    opacity: idle ? 0.4 : 1,
                  }}
                >
                  {working ? (
                    <Square
                      pointerEvents="none"
                      size={13}
                      color={c['ink-on-color']}
                      fill={c['ink-on-color']}
                    />
                  ) : (
                    <ArrowUp
                      pointerEvents="none"
                      size={19}
                      strokeWidth={2.2}
                      color={c['primary-foreground']}
                    />
                  )}
                </Press>
              </Animated.View>
            )}
          </Animated.View>
        </Glass>
      </BorderBeam>
    </View>
  )
}
