import { Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { Modal, Platform, ScrollView, useWindowDimensions, View } from 'react-native'
import { X } from 'lucide-react-native'
import { useReducedMotion } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme'
import { useKeyboardShowing } from '../data/keyboard'
import { AboveKeyboard } from './Keyboard'
import { Button, Field, GUTTER, IconButton, Label, Labelled, Notice } from './ui'

/**
 * Something asked or shown over the screen the Person was on: a form, a choice, a detail. It is
 * the system's own sheet, so it slides and swipes away the way every other sheet on the phone
 * does, and none of that motion is written here. With reduced motion it fades in instead of
 * travelling up the screen.
 */
export function Sheet({
  title,
  detail,
  onClose,
  children,
  footer,
  presentation = 'pageSheet',
  content = 'scroll',
}: {
  title?: string
  detail?: string
  onClose: () => void
  children: ReactNode
  /** Forms and choices keep their action outside scrolling content, above the native keyboard. */
  footer?: ReactNode
  /** Long tables and pictures use all available screen space; ordinary forms use the system sheet. */
  presentation?: 'pageSheet' | 'fullScreen'
  content?: 'scroll' | 'fill'
}) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  const keyboard = useKeyboardShowing()
  return (
    <Modal
      animationType={still ? 'fade' : 'slide'}
      presentationStyle={presentation}
      allowSwipeDismissal={Platform.OS === 'ios' && presentation === 'pageSheet'}
      onRequestClose={onClose}
    >
      <AboveKeyboard>
        <View
          style={{
            flex: 1,
            backgroundColor: c.screen,
            paddingTop: Platform.OS === 'ios' && presentation === 'pageSheet' ? 8 : insets.top,
            paddingBottom: keyboard ? 0 : insets.bottom,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingLeft: GUTTER,
              paddingRight: 6,
              minHeight: 52,
            }}
          >
            <View style={{ flex: 1 }}>
              {title !== undefined && (
                <Label accessibilityRole="header" numberOfLines={1} size="heading">
                  {title}
                </Label>
              )}
            </View>
            <IconButton icon={X} label="Close" onPress={onClose} />
          </View>
          <SheetBody content={content}>
            {detail !== undefined && (
              <Label size="label" tone="ink-2">
                {detail}
              </Label>
            )}
            {children}
          </SheetBody>
          {footer !== undefined && (
            <View style={{ paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: 12 }}>
              {footer}
            </View>
          )}
        </View>
      </AboveKeyboard>
    </Modal>
  )
}

/** A single scroll owner lets pinned table columns move together; pictures fill the remaining space. */
function SheetBody({ content, children }: { content: 'scroll' | 'fill'; children: ReactNode }) {
  if (content === 'fill')
    return <View style={{ flex: 1, paddingHorizontal: GUTTER }}>{children}</View>
  return (
    <ScrollView
      style={{ flex: 1 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: 32, gap: 16 }}
    >
      {children}
    </ScrollView>
  )
}

/**
 * What a bottom sheet as tall as its content holds (`FITTED_SHEET`, `ui/stack.ts`): its title, a
 * line under it when there is one, then the form or the choices. It is the content of a route,
 * not a sheet itself: the platform draws the sheet around it and sizes the sheet to it.
 *
 * It has no close button. The grabber, a swipe down, a tap on the dimmed page and Android's back
 * all close the platform's sheet, and a fifth way would only take a line from a sheet whose point
 * is to be small. The title is the header a screen reader lands on.
 *
 * The content scrolls inside a bounded height. It was a plain view, and on a small phone, with
 * large text, or with the keyboard up, the last buttons of a tall sheet sat under the keyboard
 * with no way to reach them. The bound is the window's height less the top inset less 24, the
 * cap T3 Code mobile gives its own Android sheet (`ComposerContextSheet.tsx`). Content that fits
 * is as tall as itself and does not move: neither the root nor the scroller has a `flex`, so the
 * scroller takes its content's height up to the bound, and the root takes the scroller's.
 *
 * That is still the height the platform fits the sheet to. Read in react-native-screens 4.26.2:
 * the content is laid out by React with no bottom edge (`ScreenStackItem.tsx`,
 * `absoluteWithNoBottom`), and each platform takes the height that layout came to, whatever is
 * inside it: iOS from the content wrapper's React frame (`RNSScreen.mm`,
 * `contentWrapper:receivedReactFrame:`), Android from the wrapper's own layout (`Screen.kt`,
 * `onContentWrapperLayout`).
 *
 * With the keyboard up, iOS is told to keep the scroller's end clear of it
 * (`automaticallyAdjustKeyboardInsets`). Android lifts the whole sheet above the keyboard as far
 * as the top of the screen allows (`SheetAnimationCoordinator.kt`,
 * `computeSheetOffsetYWithIMEPresent`); a sheet taller than what is left has its end behind the
 * keyboard until the keyboard is put away, which the library's own note there says too.
 *
 * Its ground is the stack's `contentStyle`, which the library paints on the sheet itself, so
 * nothing is painted here.
 */
export function FittedSheet({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  /** Left out by a sheet that has only its two lines to say. */
  children?: ReactNode
}) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  return (
    <View>
      <ScrollView
        // No `flex`: a scroller that stretched would have no height of its own to be fitted to.
        style={{ flexGrow: 0, maxHeight: height - insets.top - 24 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        // A sheet that fits has nothing to scroll, and must not rubber-band under a finger.
        alwaysBounceVertical={false}
        contentContainerStyle={{
          gap: 16,
          // Under iOS's grabber, which the system draws in the sheet's first few points.
          paddingTop: Platform.OS === 'ios' ? 28 : 12,
          paddingBottom: insets.bottom + 16,
          paddingLeft: GUTTER + insets.left,
          paddingRight: GUTTER + insets.right,
        }}
      >
        {/* Android's sheet has no grabber of its own (`sheetGrabberVisible` is iOS's), and a
            sheet that can be dragged should look it. It is a mark, not a control: the whole
            sheet drags. */}
        {Platform.OS === 'android' && (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.border,
            }}
          />
        )}
        <View style={{ gap: 4 }}>
          <Label accessibilityRole="header" size="heading">
            {title}
          </Label>
          {detail !== undefined && (
            <Label size="label" tone="ink-2">
              {detail}
            </Label>
          )}
        </View>
        {children}
      </ScrollView>
    </View>
  )
}

/**
 * A sheet that asks for one line of text: a name for a Company, a Thread, a Project, a folder.
 *
 * `onSave` answers with nothing when the change was accepted, which closes the sheet, or with
 * the sentence to show when it was refused, which keeps the sheet open with what was typed still
 * in it.
 */
export function NameSheet({
  title,
  detail,
  label,
  initial,
  placeholder,
  action,
  maxLength,
  onClose,
  onSave,
}: {
  title: string
  detail?: string
  label: string
  initial: string
  placeholder: string
  action: string
  maxLength: number
  onClose: () => void
  onSave: (value: string) => Promise<Option.Option<string>>
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const text = value.trim()

  async function save() {
    if (text.length === 0 || busy) return
    setBusy(true)
    setRefused(Option.none())
    const refusal = await onSave(text)
    setBusy(false)
    if (Option.isNone(refusal)) onClose()
    else setRefused(refusal)
  }

  return (
    <Sheet title={title} detail={detail} onClose={onClose}>
      <Labelled label={label}>
        <Field
          autoFocus
          accessibilityLabel={label}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          returnKeyType="done"
          onChangeText={setValue}
          onSubmitEditing={() => void save()}
        />
      </Labelled>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Button
        morph
        kind="primary"
        label={busy ? 'One moment…' : action}
        disabled={busy || text.length === 0}
        onPress={() => void save()}
      />
    </Sheet>
  )
}
