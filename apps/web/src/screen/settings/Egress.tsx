import { EgressStatus } from '@vivid/contracts'
import { live, LiveState, useLive } from '../../data/live'
import { Segmented } from '../../ui/Segmented'
import { Row } from './Parts'

const SWITCH = [
  { value: 'on', label: 'On', name: 'On' },
  { value: 'off', label: 'Off', name: 'Off' },
] as const

/** What is said under the switch, for each thing egress can be doing. */
const told = (status: EgressStatus) =>
  EgressStatus.match(status, {
    Off: () =>
      'Sites Vivid opens on its computer will see your own address, as when you signed in.',
    Waiting: () =>
      'On, but not in use yet: waiting for the desktop app and Vivid’s computer to connect.',
    Routing: () => 'On. Vivid’s browsing is going out through the desktop app.',
    Failed: () => 'On, but Vivid’s computer could not be reached. Vivid keeps trying.',
  })

/**
 * The one control for egress: whether the browser on Vivid's computer sends its traffic out
 * through the Person's own computer, and what came of it.
 *
 * Temporary, on purpose in one file: issue 61 removes the choice, and with it this component,
 * the one line that renders it (`General.tsx`) and `Settings.egress`. The copy follows the
 * reference's ("Route egress through this desktop", and its "Enabled, but not routing yet"
 * line), in Vivid's words.
 */
export function Egress({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
}) {
  const status = useLive(live.egress)
  return (
    <Row
      label="Send Vivid’s browsing through this computer"
      detail={LiveState.$match(status, {
        Ready: ({ value }) => told(value),
        // Until the server has said what egress is doing, the switch alone says what was chosen.
        Loading: () => told(EgressStatus.cases.Off.make({})),
        Failed: () => told(EgressStatus.cases.Off.make({})),
      })}
    >
      <Segmented
        label="Send Vivid’s browsing through this computer"
        value={enabled ? 'on' : 'off'}
        options={SWITCH}
        onChange={(next) => onChange(next === 'on')}
      />
    </Row>
  )
}
