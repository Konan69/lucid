import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  DeviceAccess,
  type ComputerHealth,
  type ComputerRecoveryRecord,
  type Device,
} from '@vivid/contracts'
import { Option } from 'effect'
import { Suspense, use, useState } from 'react'
import { deciding, health, liveStateOf, makeWhen, thisReader } from '@vivid/state'
import { cn } from '../../ui/cn'
import { standing, thisComputer } from '../../data/computers'
import { act } from '../../data/app'
import { computerHealth, computerRecovery, live, LiveState, useLive } from '../../data/live'
import { answerDevice, useDeviceDecision } from '../../data/devices'
import { Button } from '../../ui/button'
import { Empty, Refusal, Row, Section } from './Parts'

/**
 * What the list says while it has no rows. "No computer yet" is an answer, so it is only said
 * once the server has answered.
 */
const QUIET = {
  Loading: 'Looking…',
  Failed: 'Couldn’t load your computers. Try again in a moment.',
  Ready: 'No computers yet. Sign in to the Vivid desktop app on your computer to add it here.',
} satisfies Record<LiveState<unknown>['_tag'], string>

const when = makeWhen(thisReader())
/** A moment as this panel says it: the time today, else the day. */
const at = (moment: number) => when(moment, Date.now())

/** The colour of a standing's dot. */
const TONE = {
  good: 'bg-success',
  working: 'bg-working',
  bad: 'bg-danger',
  quiet: 'bg-ink-3',
} as const satisfies Record<health.HealthTone, string>

/** The colour of an ability's dot, and the word a screen reader says for it. */
const ABLE = {
  works: { dot: 'bg-success', said: 'Works' },
  idle: { dot: 'bg-ink-3', said: 'Not open' },
  broken: { dot: 'bg-danger', said: 'Not working' },
  unchecked: { dot: 'bg-line-2', said: 'Not checked' },
} as const satisfies Record<health.AbilityState, { dot: string; said: string }>

/**
 * Vivid's own computer: how it is doing, what Vivid can do on it now, and how Vivid fixes it.
 *
 * Every part is checked each time the panel asks, without waking a Computer that sleeps. The
 * steps Vivid takes to fix it are shown and never offered: recovery is Vivid's alone, from the
 * gentlest step up (`health.LADDER`), so the Person reads what happened and what comes next and
 * is asked nothing.
 */
export function VividComputer() {
  const checked = liveStateOf(useAtomValue(computerHealth))
  const recovered = liveStateOf(useAtomValue(computerRecovery))
  const again = useAtomRefresh(computerHealth)
  const againRecovered = useAtomRefresh(computerRecovery)
  return (
    <Section
      title="Vivid’s computer"
      detail="The machine Vivid works on: how it is doing and what Vivid can do there now."
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={LiveState.$is('Loading')(checked)}
          onClick={() => {
            again()
            againRecovered()
          }}
        >
          Check again
        </Button>
      }
    >
      {LiveState.$match(checked, {
        Loading: () => <Empty>Checking every part…</Empty>,
        Failed: () => <Empty>Vivid could not check its computer just now. Try again.</Empty>,
        Ready: ({ value }) => (
          <Health
            health={value}
            recovery={
              LiveState.$is('Ready')(recovered) ? Option.some(recovered.value) : Option.none()
            }
          />
        ),
      })}
    </Section>
  )
}

/** The panel's rows for one reading: its standing, what Vivid can do, and how Vivid fixes it. */
function Health({
  health: reading,
  recovery,
}: {
  health: ComputerHealth
  recovery: Option.Option<ComputerRecoveryRecord>
}) {
  const said = health.healthReading(reading, at)
  const abilities = health.abilitiesOf(reading)
  const next = health.nextStep(reading)
  const last = Option.flatMap(recovery, (record) => health.recoveryWords(record, at))
  return (
    <>
      <Row
        label={
          <span className="flex items-center gap-2">
            <i aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE[said.tone])} />
            {said.title}
          </span>
        }
        detail={said.detail}
      >
        <span className="text-meta font-meta text-ink-3 tabular-nums">
          Checked {at(reading.checkedAt)}
        </span>
      </Row>
      {abilities.length > 0 && (
        <div className="px-4 py-3">
          <p className="mb-2 text-label font-title text-ink">What Vivid can do on it now</p>
          <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {abilities.map((ability) => (
              <li key={ability.name} className="flex min-w-0 items-start gap-2 text-label">
                <i
                  role="img"
                  aria-label={ABLE[ability.state].said}
                  className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', ABLE[ability.state].dot)}
                />
                <span className="min-w-0">
                  <span className="text-ink">{ability.name}</span>
                  <span className="block text-ink-3">{ability.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="px-4 py-3">
        <p className="text-label font-title text-ink">How Vivid fixes it</p>
        <p className="mb-2 text-label text-pretty text-ink-3">
          By itself, gentlest step first, and only as far as it has to.
        </p>
        <ol className="flex flex-col gap-1">
          {health.LADDER.map((step, place) => {
            const now = Option.contains(next, step)
            return (
              <li
                key={step}
                aria-current={now ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 text-label',
                  now ? 'text-ink' : 'text-ink-3',
                )}
              >
                <span className="w-4 shrink-0 text-end tabular-nums">{place}</span>
                <span className={cn(now && 'font-title')}>{health.STEP_WORDS[step].doing}</span>
                {now && (
                  <span className="rounded-full bg-working-soft px-2 text-meta font-meta text-working">
                    Next
                  </span>
                )}
              </li>
            )
          })}
        </ol>
        {Option.isSome(last) && (
          <p role="status" className="mt-2 text-label text-pretty text-ink-2">
            {last.value}
          </p>
        )}
      </div>
    </>
  )
}

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
