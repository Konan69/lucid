import type { Device } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { Suspense, use, useState } from 'react'
import {
  allowed,
  allowing,
  nudgeThisComputer,
  standing,
  stopping,
  thisComputer,
} from '../../data/computers'
import { change, live, LiveState, useLive } from '../../data/live'
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
 * the only place that decision is made on the web, and it is the same list on every surface.
 *
 * The list is live. It used to be asked for once when Settings opened and again after each
 * decision, so a desktop app signing in on another machine did not show until the page was
 * reloaded. Now it is a `Watch…` query like every other list: a new computer appears, waiting,
 * while this is open, and a decision is shown at once and taken back if the server refuses it.
 */
export function YourComputers() {
  const state = useLive(live.devices)
  const [refused, setRefused] = useState<string | null>(null)
  // Which computer this window is running on. Only the desktop app can say, and it says once.
  const [here] = useState(thisComputer)

  /** Shows a decision at once, sends it, and says so when the server would not take it. */
  async function decide(
    made: ReturnType<typeof change<{ readonly device: Device }>>,
    words: string,
  ) {
    const result = await made
    setRefused(Result.isFailure(result) ? words : null)
    // The desktop app hears of the decision now, instead of on its next scheduled look.
    await nudgeThisComputer()
  }

  const devices = LiveState.$is('Ready')(state) ? state.value.devices : []
  return (
    <>
      <Refusal message={refused} />
      <Section
        title="Your computers"
        detail="Vivid can open and use pages in the Vivid desktop app on one computer you allow. A page Vivid is using shows a Stop button."
      >
        {devices.length === 0 ? (
          <Empty>{QUIET[state._tag]}</Empty>
        ) : (
          <Suspense fallback={<Empty>Looking…</Empty>}>
            <ComputerList
              devices={devices}
              here={here}
              onAllow={(device) =>
                void decide(
                  change(
                    (client) => client.AllowDevice({ id: device.id }),
                    () => live.devices.expect(allowing(device.id, Date.now())),
                  ),
                  `${device.name} could not be allowed. Try again.`,
                )
              }
              onStop={(device) =>
                void decide(
                  change(
                    (client) => client.RevokeDevice({ id: device.id }),
                    () => live.devices.expect(stopping(device.id, Date.now())),
                  ),
                  `${device.name} is still allowed. Try again.`,
                )
              }
            />
          </Suspense>
        )}
      </Section>
    </>
  )
}

function ComputerList({
  devices,
  here,
  onAllow,
  onStop,
}: {
  devices: ReadonlyArray<Device>
  here: ReturnType<typeof thisComputer>
  onAllow: (device: Device) => void
  onStop: (device: Device) => void
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
          {allowed(device) ? (
            <Button size="sm" variant="ghost" onClick={() => onStop(device)}>
              Stop allowing
            </Button>
          ) : (
            <Button size="sm" onClick={() => onAllow(device)}>
              Allow
            </Button>
          )}
        </Row>
      ))}
    </>
  )
}
