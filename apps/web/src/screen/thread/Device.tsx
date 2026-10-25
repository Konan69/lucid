import {
  deciding,
  DEVICE_QUESTION,
  deviceAnswers,
  deviceWaiting,
  makeWhen,
  thisReader,
  type DeviceWaiting,
} from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { answerDevice, useDeviceDecision } from '../../data/devices'
import { live, useLiveValue } from '../../data/live'
import { openSettings } from '../../router'
import { Button } from '../../ui/button'

const when = makeWhen(thisReader())

/** A separate section keeps the device decision available while a chat question or approval is open. */
export function DeviceAsk() {
  const waiting = Option.flatMap(useLiveValue(live.devices), deviceWaiting)
  const [now] = useState(() => Date.now())
  if (Option.isNone(waiting)) return null
  return (
    <section aria-label="Pending device request" className="shrink-0 px-4 py-2">
      <div className="mx-auto w-full max-w-180">
        <Computer waiting={waiting.value} now={now} />
      </div>
    </section>
  )
}

/** The accepted Feed device card, without a conversation post or an independent dismiss action. */
export function Computer({ waiting, now }: { waiting: DeviceWaiting; now: number }) {
  const reading = useDeviceDecision()
  const [allow, deny] = deviceAnswers(waiting.device, waiting.instead)
  const refusal = deciding.refusalFor(reading, waiting.device.id)
  const held = deciding.isWaiting(reading)
  return (
    <article
      aria-label={`Device request for ${waiting.device.name}`}
      className="overflow-hidden rounded-composer bg-surface-3 p-4 edge"
    >
      <div className="flex min-h-5.5 items-center gap-2 text-label text-ink-2">
        <span className="min-w-0 truncate">{waiting.device.name}</span>
        <time
          className="ms-auto text-ink-3 tabular-nums"
          dateTime={new Date(waiting.since).toISOString()}
        >
          {when(waiting.since, now)}
        </time>
      </div>
      <h2 className="mt-3">
        <button
          type="button"
          className="cursor-pointer rounded-row text-start text-section font-strong tracking-tight text-balance text-ink underline-offset-4 hover:underline focus-visible:outline-offset-2"
          onClick={() => void openSettings('devices')}
        >
          {DEVICE_QUESTION}
        </button>
      </h2>
      <p className="mt-1 text-title text-pretty text-ink-2">{allow.detail}</p>
      {Option.isSome(refusal) && (
        <p role="alert" className="mt-2 text-label text-danger">
          {refusal.value}
        </p>
      )}
      <footer className="mt-3 flex justify-end gap-2">
        <Button
          variant="secondary"
          disabled={held}
          onClick={() => answerDevice(waiting.device, false)}
        >
          {deny.label}
        </Button>
        <Button disabled={held} onClick={() => answerDevice(waiting.device, true)}>
          {allow.label}
        </Button>
      </footer>
    </article>
  )
}
