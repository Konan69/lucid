import { useState } from 'react'
import { Platform, Pressable, Text, TextInput, View } from 'react-native'
import DateTimePicker from '@react-native-community/datetimepicker'
import { useTheme } from '../theme'

function local(value: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    value.getFullYear() +
    '-' +
    pad(value.getMonth() + 1) +
    '-' +
    pad(value.getDate()) +
    ' ' +
    pad(value.getHours()) +
    ':' +
    pad(value.getMinutes())
  )
}
export function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const { colors: c } = useTheme()
  const [mode, setMode] = useState<'date' | 'time'>()
  const parsed = new Date(value.replace(' ', 'T'))
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date()
  if (Platform.OS === 'web')
    return (
      <TextInput
        accessibilityLabel={label}
        placeholder="YYYY-MM-DD HH:mm"
        value={value}
        onChangeText={onChange}
        style={{
          minHeight: 48,
          padding: 12,
          color: c.ink,
          backgroundColor: c['surface-2'],
          borderRadius: 14,
        }}
      />
    )
  const button = (title: string, action: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={action}
      style={{
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: c['surface-2'],
      }}
    >
      <Text style={{ color: c.ink, fontSize: 15 }}>{title}</Text>
    </Pressable>
  )
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {button(value ? date.toLocaleDateString() : 'Set date', () => setMode('date'))}
        {button(
          value
            ? date.toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
              })
            : 'Set time',
          () => setMode('time'),
        )}
        {value ? button('Clear', () => onChange('')) : null}
      </View>
      {mode && (
        <DateTimePicker
          value={date}
          mode={mode}
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onValueChange={(_event, next) => {
            if (Platform.OS === 'android') setMode(undefined)
            onChange(local(next))
          }}
          onDismiss={() => setMode(undefined)}
        />
      )}
      {mode && Platform.OS === 'ios' && button('Done', () => setMode(undefined))}
    </View>
  )
}
