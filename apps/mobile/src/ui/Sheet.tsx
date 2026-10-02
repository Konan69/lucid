import { Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { Modal, Platform, ScrollView, View } from 'react-native'
import { X } from 'lucide-react-native'
import { useReducedMotion } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme'
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
}: {
  /** Pictures may have no filename; the sheet keeps that absence instead of inventing a title. */
  title?: string
  detail?: string
  onClose: () => void
  children: ReactNode
}) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const still = useReducedMotion()
  return (
    <Modal
      animationType={still ? 'fade' : 'slide'}
      presentationStyle="pageSheet"
      allowSwipeDismissal={Platform.OS === 'ios'}
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: c['surface-0'],
          // An iOS sheet starts below the status bar by itself; Android's covers the screen.
          paddingTop: Platform.OS === 'ios' ? 8 : insets.top,
          paddingBottom: insets.bottom,
          // Clear of a notch or a rounded corner when the phone is on its side.
          paddingLeft: insets.left,
          paddingRight: insets.right,
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
              <Label accessibilityRole="header" numberOfLines={1} size="headline">
                {title}
              </Label>
            )}
          </View>
          <IconButton icon={X} label="Close" onPress={onClose} />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: 32, gap: 16 }}
        >
          {detail !== undefined && (
            <Label size="label" tone="ink-3">
              {detail}
            </Label>
          )}
          {children}
        </ScrollView>
      </View>
    </Modal>
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
        kind="primary"
        label={busy ? 'One moment…' : action}
        disabled={busy || text.length === 0}
        onPress={() => void save()}
      />
    </Sheet>
  )
}
