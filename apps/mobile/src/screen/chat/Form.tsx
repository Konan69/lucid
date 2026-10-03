import type { Shown } from '@vivid/contracts'
import { formReply } from '@vivid/state'
import DateTimePicker from '@react-native-community/datetimepicker'
import { MenuView } from '@react-native-menu/menu'
import { useState } from 'react'
import { ActionSheetIOS, Platform, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import type { Say } from '../../data/delivery'
import { commit, tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { Sheet } from '../../ui/Sheet'
import { Button, Field, Label, Press, radius } from '../../ui/ui'
import { Frame } from './Frame'

type FormKind = Extract<Shown, { readonly _tag: 'Form' }>
type FieldKind = FormKind['fields'][number]
type ControlProps = { field: FieldKind; value: string; onChange: (value: string) => void }

/** Each field keeps the value typed into it; pairing them means a field never has to be looked up. */
interface Entry {
  readonly field: FieldKind
  readonly value: string
}

/**
 * A form asked for in a Thread. The card shows what is being asked and what has been filled so
 * far; filling it in happens in a bottom sheet, where the keyboard and the control fit each
 * field (number pad, a wheel for a date, the system's own menu for a choice) and the submit
 * button stays above the keyboard. Closing the sheet keeps what was typed. Submitting says the
 * answers in the Thread as the Person's next message, one "Label: value" line each; a field
 * left empty is simply not said.
 */
export function Form({ form, live, onSay }: { form: FormKind; live: boolean; onSay: Say }) {
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [entries, setEntries] = useState<ReadonlyArray<Entry>>(() =>
    form.fields.map((field) => ({ field, value: '' })),
  )
  const answerable = live && !sent
  const words = formReply(entries.map(({ field, value }) => ({ label: field.label, value })))
  const edit = (index: number, value: string) =>
    setEntries((now) => now.map((entry, at) => (at === index ? { ...entry, value } : entry)))
  const submit = () => {
    if (!answerable || words.length === 0) return
    commit()
    setSent(true)
    setOpen(false)
    // Answers that did not arrive stay in their fields and can be sent, or changed, again.
    void onSay(words).then(setSent)
  }
  return (
    <Frame title={form.title}>
      <View>
        {entries.map(({ field, value }) => (
          <View
            key={field.label}
            accessible
            accessibilityLabel={`${field.label}: ${value.length === 0 ? 'empty' : value}`}
            style={{ gap: 2, paddingVertical: 8 }}
          >
            <Label size="caption" tone="ink-2">
              {field.label}
            </Label>
            <Label size="label" tone={value.length === 0 ? 'ink-4' : 'ink'} numberOfLines={2}>
              {value.length === 0 ? asked(field) : value}
            </Label>
          </View>
        ))}
      </View>
      {answerable && (
        <Button
          kind="primary"
          label={words.length === 0 ? 'Fill it in' : 'Review and send'}
          onPress={() => setOpen(true)}
        />
      )}
      {open && answerable && (
        <Sheet
          title={form.title}
          onClose={() => setOpen(false)}
          footer={
            <Button
              kind="primary"
              label={form.submit}
              disabled={words.length === 0}
              onPress={submit}
            />
          }
        >
          {entries.map(({ field, value }, index) => (
            <View key={field.label} style={{ gap: 8 }}>
              <Label size="label" tone="ink-2">
                {field.label}
              </Label>
              <Control field={field} value={value} onChange={(next) => edit(index, next)} />
            </View>
          ))}
        </Sheet>
      )}
    </Frame>
  )
}

/** What an empty field says it is waiting for: the example Vivid gave, or the kind of answer. */
const asked = (field: FieldKind): string => {
  if (field.example !== undefined) return field.example
  return field.kind === 'choice' ? 'Choose one' : 'Not filled in'
}

/** The control for one kind of field; every kind brings up the keyboard or picker made for it. */
function Control({ field, value, onChange }: ControlProps) {
  switch (field.kind) {
    case 'choice':
      return <Choice field={field} value={value} onChange={onChange} />
    case 'date':
      return <DateField field={field} value={value} onChange={onChange} />
    // The typed kinds share one text field and differ only in its size and keyboard.
    case 'text':
    case 'long text':
    case 'number': {
      const long = field.kind === 'long text'
      return (
        <Field
          accessibilityLabel={field.label}
          value={value}
          placeholder={field.example}
          multiline={long}
          // A number may carry a decimal point, which the plain number pad does not have.
          keyboardType={field.kind === 'number' ? 'decimal-pad' : 'default'}
          returnKeyType={long ? 'default' : 'done'}
          textAlignVertical={long ? 'top' : 'center'}
          onChangeText={onChange}
          style={{ minHeight: long ? 120 : 52 }}
        />
      )
    }
  }
}

const PICKER = {
  minHeight: 52,
  paddingHorizontal: 14,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  borderRadius: radius.control,
} as const

/** The look of a field that opens a picker instead of a keyboard, with the chevron that says so. */
function Picker({
  label,
  value,
  placeholder,
  onPress,
}: {
  label: string
  value: string
  placeholder: string
  onPress?: () => void
}) {
  const { colors: c } = useTheme()
  const body = (
    <>
      <Label size="reading" tone={value.length === 0 ? 'ink-4' : 'ink'} style={{ flex: 1 }}>
        {value.length === 0 ? placeholder : value}
      </Label>
      <ChevronDown pointerEvents="none" size={18} color={c['foreground-secondary']} />
    </>
  )
  if (onPress === undefined)
    return (
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: value.length === 0 ? placeholder : value }}
        style={[PICKER, { backgroundColor: c['md-code-bg'] }]}
      >
        {body}
      </View>
    )
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: value.length === 0 ? placeholder : value }}
      onPress={onPress}
      style={({ pressed }) => [
        PICKER,
        { backgroundColor: pressed ? c['wash-pressed'] : c['md-code-bg'] },
      ]}
    >
      {body}
    </Press>
  )
}

/** iOS uses its action sheet; Android's installed native menu owns selection and touch feedback. */
function Choice({ field, value, onChange }: ControlProps) {
  const { dark } = useTheme()
  const choose = (choice: string) => {
    tick()
    onChange(choice)
  }
  const picker = (onPress?: () => void) => (
    <Picker label={field.label} value={value} placeholder="Choose one" onPress={onPress} />
  )
  if (Platform.OS === 'ios')
    return picker(() =>
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: field.label,
          options: [...field.choices, 'Cancel'],
          cancelButtonIndex: field.choices.length,
        },
        (index) => {
          const choice = field.choices[index]
          if (choice !== undefined) choose(choice)
        },
      ),
    )
  return (
    <MenuView
      title={field.label}
      themeVariant={dark ? 'dark' : 'light'}
      actions={field.choices.map((choice) => ({
        id: choice,
        title: choice,
        state: choice === value ? 'on' : 'off',
      }))}
      onPressAction={({ nativeEvent }) => {
        if (field.choices.includes(nativeEvent.event)) choose(nativeEvent.event)
      }}
    >
      {picker()}
    </MenuView>
  )
}

/** A date is written as the day it is (`2026-10-03`), from the calendar's local parts, never UTC. */
const dayOf = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/**
 * The platform's own date picker. iOS shows its wheel in a sheet with a Done button; Android
 * shows its calendar dialog, whose choice is the answer. An empty field points at today, but
 * only an explicit choice fills it.
 */
function DateField({ field, value, onChange }: ControlProps) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(() =>
    value.length === 0 ? new Date() : new Date(`${value}T12:00:00`),
  )
  const select = (date: Date) => {
    tick()
    onChange(dayOf(date))
    setOpen(false)
  }
  const picker = (
    <DateTimePicker
      value={cursor}
      mode="date"
      display={Platform.OS === 'ios' ? 'spinner' : 'default'}
      onDismiss={() => setOpen(false)}
      onValueChange={(_event, date) => {
        setCursor(date)
        if (Platform.OS === 'android') select(date)
      }}
    />
  )
  return (
    <>
      <Picker
        label={field.label}
        value={value}
        placeholder={field.example === undefined ? 'Pick a day' : field.example}
        onPress={() => setOpen(true)}
      />
      {open &&
        (Platform.OS === 'ios' ? (
          <Sheet
            title={field.label}
            onClose={() => setOpen(false)}
            footer={<Button label="Done" kind="primary" onPress={() => select(cursor)} />}
          >
            {picker}
          </Sheet>
        ) : (
          picker
        ))}
    </>
  )
}
