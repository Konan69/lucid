import { Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { Modal, Platform, ScrollView, View } from 'react-native'
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
