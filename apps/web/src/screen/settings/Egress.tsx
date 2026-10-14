import { EgressStatus } from '@vivid/contracts'
import { LiveState } from '@vivid/state'
import { Segmented } from '../../ui/Segmented'
import { Row } from './Parts'

const SWITCH = [
  { value: 'on', label: 'On', name: 'On' },
  { value: 'off', label: 'Off', name: 'Off' },
] as const

/**
 * What is said under the switch: one true sentence for each thing the server can have said, and
 * one each for not having heard yet and for not being able to ask.
 *
 * Turning it off is felt at once (the join ends and the same browser goes out from Vivid's
 * computer). Turning it on is not always: a browser keeps the way out it was started with
 * (`apps/server/src/computers/README.md`, "Egress"), so one that was already open goes on as it
 * was until Vivid's computer opens it again. The line for the working case says so.
 */
export const said = (status: LiveState<EgressStatus>): string =>
  LiveState.$match(status, {
    Loading: () => 'Checking whether Vivid’s browsing is going through your computer.',
    Failed: () => 'Vivid could not check whether its browsing is going through your computer.',
    Ready: ({ value }) =>
      EgressStatus.match(value, {
        Off: () => 'Off. Sites Vivid opens see the address of Vivid’s computer, not yours.',
        Waiting: () =>
          'On, but not in use yet. It starts when Vivid’s computer is running and the Vivid app is open on your computer.',
        Routing: () =>
          'On. Sites Vivid opens see your computer’s address. A browser that was already open on Vivid’s computer changes over the next time Vivid opens it.',
        Failed: () =>
          'On, but Vivid’s computer could not be connected to yours. Vivid keeps trying.',
      }),
  })

/**
 * The one control for egress: whether the browser on Vivid's computer sends its traffic out
 * through the Person's own computer, and what came of it.
 *
 * Temporary, on purpose in one file: issue 61 removes the choice, and with it this component,
 * the lines that render it (`General.tsx`) and `Settings.egress`. The copy follows the
 * reference's ("Route egress through this desktop", and its "Enabled, but not routing yet"
 * line), in Vivid's words.
 */
export function Egress({
  enabled,
  status,
  onChange,
}: {
  enabled: boolean
  status: LiveState<EgressStatus>
  onChange: (enabled: boolean) => void
}) {
  return (
    <Row label="Send Vivid’s browsing through this computer" detail={said(status)}>
      <Segmented
        label="Send Vivid’s browsing through this computer"
        value={enabled ? 'on' : 'off'}
        options={SWITCH}
        onChange={(next) => onChange(next === 'on')}
      />
    </Row>
  )
}
