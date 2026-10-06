import { makeWhen, thisReader } from '@vivid/state'
import { Result } from 'effect'
import { Suspense, use, useState } from 'react'
import {
  signedInDevices,
  signOutDevice,
  signOutElsewhere,
  type SignedInDevice,
} from '../../data/account'
import { run } from '../../data/app'
import { Button } from '../../ui/button'
import { YourComputers } from './Computers'
import { Empty, Refusal, Row, Section } from './Parts'

/**
 * This Person's computers, and everywhere they are signed in, each with a way to sign it out.
 * Nothing is signed in from here: every app signs itself in, with a password or with Google.
 */
export function Devices() {
  return (
    <>
      <YourComputers />
      <SignedIn />
    </>
  )
}

const reader = thisReader()
const when = makeWhen(reader)

/** Asks where this Person is signed in, and notes when. A failure is an answer too. */
const ask = async () => ({ answer: await run(signedInDevices()), at: Date.now() })

/**
 * Everywhere this Person is signed in, each with a way to sign it out. A phone that was lost, a
 * browser on a computer that was borrowed: without this the only way to end one was to change
 * the password for all of them. This device is listed first and is signed out from General.
 */
function SignedIn() {
  // The list as last asked for. Signing a device out asks again, so the list is what the server
  // now says, not this screen's guess at it.
  const [asked, setAsked] = useState(ask)
  const [refused, setRefused] = useState<string | null>(null)

  async function end(made: Promise<Result.Result<unknown, unknown>>, words: string) {
    const result = await made
    setRefused(Result.isFailure(result) ? words : null)
    setAsked(ask())
  }

  return (
    <>
      <Refusal message={refused} />
      <Section
        title="Where you are signed in"
        detail="Sign out a device you no longer use or no longer have."
      >
        <Suspense fallback={<Empty>Looking…</Empty>}>
          <DeviceList
            asked={asked}
            onSignOut={(device) =>
              void end(
                run(signOutDevice(device)),
                `${device.name} could not be signed out. Try again.`,
              )
            }
            onSignOutElsewhere={() =>
              void end(
                run(signOutElsewhere()),
                'The other devices could not be signed out. Try again.',
              )
            }
          />
        </Suspense>
      </Section>
    </>
  )
}

function DeviceList({
  asked,
  onSignOut,
  onSignOutElsewhere,
}: {
  asked: ReturnType<typeof ask>
  onSignOut: (device: SignedInDevice) => void
  onSignOutElsewhere: () => void
}) {
  // `at` is when the list was asked for, which is the "now" its times are said against.
  const { answer, at } = use(asked)
  if (Result.isFailure(answer)) {
    return <Empty>Vivid could not list your devices just now. Open this again in a moment.</Empty>
  }
  const devices = answer.success
  const elsewhere = devices.filter((device) => !device.here)
  return (
    <>
      {devices.map((device) => (
        <Row
          key={device.id}
          label={device.here ? `${device.name} · this device` : device.name}
          detail={`Last used ${when(device.lastUsedAt, at)}`}
        >
          {!device.here && (
            <Button size="sm" variant="ghost" onClick={() => onSignOut(device)}>
              Sign out
            </Button>
          )}
        </Row>
      ))}
      {elsewhere.length > 1 && (
        <div className="flex justify-end px-4 py-2.5">
          <Button size="sm" variant="destructive" onClick={onSignOutElsewhere}>
            Sign out everywhere else
          </Button>
        </div>
      )}
    </>
  )
}
