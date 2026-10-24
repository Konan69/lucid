import { DeviceAccess, type Device } from '@vivid/contracts'
import { Option } from 'effect'
import { Suspense, use, useState } from 'react'
import { deciding } from '@vivid/state'
import { standing, thisComputer } from '../../data/computers'
import { act } from '../../data/app'
import { live, LiveState, useLive } from '../../data/live'
import { answerDevice, useDeviceDecision } from '../../data/devices'
import { Button } from '../../ui/button'
import { Empty, Refusal, Row, Section } from './Parts'

/**
 * What the list says while it has no rows. "No computer yet" is an answer, so it is only said
 * once the server has answered.
 */
const QUIET = {
  Loading: 'Looking…',
  Failed: 'Vivid could not list your computers just now. Open this again in a moment.',
  Ready:
    'No computer yet. Open the Vivid desktop app on your computer and sign in, and it appears here.',
} satisfies Record<LiveState<unknown>['_tag'], string>

/**
 * The Person's own computers, and the one decision about each: whether Vivid may use it.
 *
 * A computer appears here when the Vivid desktop app on it is signed in; appearing grants nothing.
 * Allowing one stops allowing any other, because Vivid acts on one computer at a time. This is
 * the same decision offered on the Feed and in persistent request sections.
 *
 * The list is live. It used to be asked for once when Settings opened and again after each
 * decision, so a desktop app signing in on another machine did not show until the page was
 * reloaded. Now it is a `Watch…` query like every other list: a new computer appears, waiting,
 * while this is open. A request stays visible until the server confirms the decision.
 */
export function YourComputers() {
  const state = useLive(live.devices)
  // Which computer this window is running on. Only the desktop app can say, and it says once.
  const [here] = useState(() => act(thisComputer))

  const devices = LiveState.$is('Ready')(state) ? state.value.devices : []
  return (
    <>
      <Section
        title="Your computers"
        detail="Vivid can open and use pages in the Vivid desktop app on one computer you allow. A page Vivid is using shows a Stop button."
      >
        {devices.length === 0 ? (
          <Empty>{QUIET[state._tag]}</Empty>
        ) : (
          <Suspense fallback={<Empty>Looking…</Empty>}>
            <ComputerList devices={devices} here={here} />
          </Suspense>
        )}
      </Section>
    </>
  )
}

/** Each row reads its attempt from the same machine as Feed and the persistent request section. */
function ComputerList({
  devices,
  here,
}: {
  devices: ReadonlyArray<Device>
  here: Promise<Option.Option<string>>
}) {
  const mine = use(here)
  return (
    <>
      {devices.map((device) => (
        <Row
          key={device.id}
          label={Option.contains(mine, device.id) ? `${device.name} · this computer` : device.name}
          detail={standing(device)}
        >
          <ComputerActions device={device} />
        </Row>
      ))}
    </>
  )
}

/** Builds action elements before matching access so the match selects controls without defining components. */
function ComputerActions({ device }: { device: Device }) {
  const reading = useDeviceDecision()
  const held = deciding.isWaiting(reading)
  const allow = (
    <Button size="sm" disabled={held} onClick={() => answerDevice(device, true)}>
      Allow
    </Button>
  )
  const deny = (
    <Button
      size="sm"
      variant="secondary"
      disabled={held}
      onClick={() => answerDevice(device, false)}
    >
      Deny
    </Button>
  )
  const stop = (
    <Button size="sm" variant="ghost" disabled={held} onClick={() => answerDevice(device, false)}>
      Stop allowing
    </Button>
  )
  const pending = (
    <>
      {deny}
      {allow}
    </>
  )
  return (
    <>
      <Refusal message={Option.getOrNull(deciding.refusalFor(reading, device.id))} />
      {DeviceAccess.match(device.access, {
        Allowed: () => stop,
        Pending: () => pending,
        Revoked: () => allow,
      })}
    </>
  )
}
