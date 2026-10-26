import { DeviceAccess, DevicePresence, type Device } from '@vivid/contracts'
import { deciding } from '@vivid/state'
import { Option } from 'effect'
import { View } from 'react-native'
import { arrive, standingOf } from '../../data/computer'
import { answerDevice, useDeviceDecision } from '../../data/devices'
import { LiveState, useLive, useLiveData } from '../../data/live'
import { useGo, useMe } from '../../workspace'
import { Row, Section } from '../../ui/List'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import { Button, Notice, Skeleton } from '../../ui/ui'

/** Access and connection are separate facts. An offline computer may still need an answer. */
const standing = (device: Device) => {
  const access = DeviceAccess.match(device.access, {
    Pending: () => 'Waiting for your decision.',
    Allowed: () => 'Allowed.',
    Revoked: () => 'Not allowed.',
  })
  const presence = DevicePresence.match(device.presence, {
    Offline: () => 'Desktop app offline.',
    Connected: () => 'Desktop app connected.',
  })
  return `${access} ${presence}`
}

/** Native access management. Phone sign-in sessions and Vivid's Computer grant no personal access. */
export function Devices({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const state = useLive(data.live.devices)
  const computer = useLive(data.live.computer)
  const me = useMe()
  const go = useGo()
  const openComputer = () => {
    onClose()
    arrive(data)
    go.navigate('Computer')
  }
  // The section header already names the thing, so the row says how it stands: the header
  // and the row both read "Vivid's Computer" until 26 October 2026 (seen on an iPhone).
  const computerRow = LiveState.$match(computer, {
    Loading: () => ({ title: 'Looking for it…', detail: Option.none<string>() }),
    Failed: ({ failure }) => ({
      title: 'Could not check it',
      detail: Option.some(failure.message),
    }),
    Ready: ({ value }) => {
      const now = standingOf(value.computer)
      return { title: now.title, detail: Option.some(now.detail) }
    },
  })
  return (
    <Sheet title="Devices" onClose={onClose}>
      <Section title="This phone">
        <Row title={me.person.email} detail="Signed in on this phone." wrap />
      </Section>
      <Section title="Vivid's Computer">
        <Row
          title={computerRow.title}
          detail={Option.getOrUndefined(computerRow.detail)}
          onPress={openComputer}
          wrap
        />
      </Section>
      <Live state={state} loading={<Skeleton rows={3} />}>
        {({ devices }) => (
          <Section
            title="Your computers"
            detail="Allowing one stops allowing the previous one. A notice shows while Vivid works there."
          >
            {devices.length === 0 && (
              <Row
                title="No personal computers yet"
                detail="Open the Vivid desktop app on your computer and sign in to add it here."
                wrap
              />
            )}
            {devices.map((device) => (
              <Computer key={device.id} device={device} />
            ))}
          </Section>
        )}
      </Live>
    </Sheet>
  )
}

/** The same session-owned attempt drives Settings and every persistent pending card. */
function Computer({ device }: { device: Device }) {
  const data = useLiveData()
  const reading = useDeviceDecision()
  const held = deciding.isWaiting(reading)
  const refused = deciding.refusalFor(reading, device.id)
  const allow = (
    <Button
      label="Allow"
      kind="primary"
      disabled={held}
      onPress={() => answerDevice(data, device, true)}
    />
  )
  const deny = (
    <Button label="Deny" disabled={held} onPress={() => answerDevice(data, device, false)} />
  )
  const stop = (
    <Button
      label="Stop allowing"
      disabled={held}
      onPress={() => answerDevice(data, device, false)}
    />
  )
  const pending = (
    <>
      {deny}
      {allow}
    </>
  )
  return (
    <View accessibilityLabel={`Computer ${device.name}`} style={{ paddingBottom: 12, gap: 8 }}>
      <Row title={device.name} detail={standing(device)} wrap />
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <View style={{ paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {DeviceAccess.match(device.access, {
          Pending: () => pending,
          Revoked: () => allow,
          Allowed: () => stop,
        })}
      </View>
    </View>
  )
}
