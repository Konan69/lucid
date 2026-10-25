import {
  deciding,
  DEVICE_QUESTION,
  deviceAnswers,
  makeWhen,
  thisReader,
  type DeviceWaiting,
} from '@vivid/state'
import { Option } from 'effect'
import { View } from 'react-native'
import { answerDevice, useDeviceDecision } from '../../data/devices'
import { useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Button, EDGE, Label, Notice } from '../../ui/ui'

const when = makeWhen(thisReader())

/** The accepted device Feed card uses explicit access controls and never impersonates a Feed post. */
export function Computer({ waiting, now }: { waiting: DeviceWaiting; now: number }) {
  const data = useLiveData()
  const reading = useDeviceDecision()
  const { colors: c } = useTheme()
  const [allow, deny] = deviceAnswers(waiting.device, waiting.instead)
  const refusal = deciding.refusalFor(reading, waiting.device.id)
  const held = deciding.isWaiting(reading)
  return (
    <View
      accessibilityLabel={`Device request for ${waiting.device.name}`}
      style={{
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c['line-2'],
        backgroundColor: c.card,
        padding: 16,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Label size="label" tone="ink-2" numberOfLines={1} style={{ flex: 1 }}>
          {waiting.device.name}
        </Label>
        <Label size="label" tone="ink-3">
          {when(waiting.since, now)}
        </Label>
      </View>
      <Label accessibilityRole="header" size="headline">
        {DEVICE_QUESTION}
      </Label>
      <Label size="footnote" tone="ink-2">
        {allow.detail}
      </Label>
      {Option.isSome(refusal) && <Notice message={refusal.value} />}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={deny.label}
          disabled={held}
          onPress={() => answerDevice(data, waiting.device, false)}
          containerStyle={{ flex: 1 }}
        />
        <Button
          label={allow.label}
          kind="primary"
          disabled={held}
          onPress={() => answerDevice(data, waiting.device, true)}
          containerStyle={{ flex: 1 }}
        />
      </View>
    </View>
  )
}
