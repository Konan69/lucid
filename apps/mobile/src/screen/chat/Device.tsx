import {
  deciding,
  deviceAnswers,
  deviceQuestion,
  devicesWaiting,
  makeWhen,
  thisReader,
  type DeviceWaiting,
} from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { answerDevice, useDeviceDecision } from '../../data/devices'
import { useLiveData, useLiveValue } from '../../data/live'
import { useTheme } from '../../theme'
import { Button, EDGE, Label, Notice } from '../../ui/ui'

const when = makeWhen(thisReader())

/** Independent of chat questions and approvals, with no hide or dismiss control. */
export function DeviceAsk() {
  const data = useLiveData()
  const devices = useLiveValue(data.live.devices)
  const waiting = Option.match(devices, { onNone: () => [], onSome: devicesWaiting })
  const [now] = useState(() => Date.now())
  if (waiting.length === 0) return null
  return (
    <View style={{ maxHeight: 240, flexShrink: 0 }}>
      <ScrollView
        accessibilityLabel="Pending device requests"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 12, gap: 12 }}
      >
        {waiting.map((request) => (
          <Computer key={request.device.id} waiting={request} now={now} />
        ))}
      </ScrollView>
    </View>
  )
}

/** The accepted device Feed card uses explicit access controls and never impersonates a Feed post. */
export function Computer({ waiting, now }: { waiting: DeviceWaiting; now: number }) {
  const data = useLiveData()
  const reading = useDeviceDecision()
  const { colors: c } = useTheme()
  const [allow, deny] = deviceAnswers(waiting.instead)
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
        <Label size="label" tone="ink-2" style={{ flex: 1 }}>
          Your computers
        </Label>
        <Label size="label" tone="ink-3">
          {when(waiting.since, now)}
        </Label>
      </View>
      <Label accessibilityRole="header" size="headline">
        {deviceQuestion(waiting.device)}
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
