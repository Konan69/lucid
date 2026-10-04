import type { Device } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { Suspense, use, useState } from 'react'
import { run } from '../../data/app'
import {
  allowComputer,
  allowed,
  nudgeThisComputer,
  standing,
  stopAllowingComputer,
  thisComputer,
  yourComputers,
} from '../../data/computers'
import { Button } from '../../ui/button'
import { Empty, Refusal, Row, Section } from './Parts'

/** Asks for the Person's computers and which one this is. A failure is an answer too. */
const ask = async () => ({ answer: await run(yourComputers()), here: await thisComputer() })

/**
 * The Person's own computers, and the one decision about each: whether Vivid may use it.
 *
 * A computer appears here when the Vivid desktop app on it is signed in; appearing grants nothing.
 * Allowing one stops allowing any other, because Vivid acts on one computer at a time. This is
 * the only place that decision is made on the web, and it is the same list on every surface.
 */
export function YourComputers() {
  // The list as last asked for. A decision asks again, so the rows are what the server now says.
  const [asked, setAsked] = useState(ask)
  const [refused, setRefused] = useState<string | null>(null)

  async function decide(made: Promise<Result.Result<Device, unknown>>, words: string) {
    const result = await made
    setRefused(Result.isFailure(result) ? words : null)
    // The desktop app hears of the decision now, instead of on its next scheduled look.
    await nudgeThisComputer()
    setAsked(ask())
  }

  return (
    <>
      <Refusal message={refused} />
      <Section
        title="Your computers"
        detail="Vivid can open and use pages in the Vivid desktop app on one computer you allow. Touch a page Vivid is using to take over."
      >
        <Suspense fallback={<Empty>Looking…</Empty>}>
          <ComputerList
            asked={asked}
            onAllow={(device) =>
              void decide(
                run(allowComputer(device.id)),
                `${device.name} could not be allowed. Try again.`,
              )
            }
            onStop={(device) =>
              void decide(
                run(stopAllowingComputer(device.id)),
                `${device.name} is still allowed. Try again.`,
              )
            }
          />
        </Suspense>
      </Section>
    </>
  )
}

function ComputerList({
  asked,
  onAllow,
  onStop,
}: {
  asked: ReturnType<typeof ask>
  onAllow: (device: Device) => void
  onStop: (device: Device) => void
}) {
  const { answer, here } = use(asked)
  if (Result.isFailure(answer)) {
    return <Empty>Vivid could not list your computers just now. Open this again in a moment.</Empty>
  }
  if (answer.success.length === 0) {
    return (
      <Empty>
        No computer yet. Open the Vivid desktop app on your computer and sign in, and it appears
        here.
      </Empty>
    )
  }
  return (
    <>
      {answer.success.map((device) => (
        <Row
          key={device.id}
          label={Option.contains(here, device.id) ? `${device.name} · this computer` : device.name}
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
