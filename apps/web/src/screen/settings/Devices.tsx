import { makeWhen, thisReader } from '@vivid/state'
import { Result } from 'effect'
import { Suspense, use, useState } from 'react'
import {
  approveDevice,
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
 * Signing in a phone or the desktop app. The other device shows a short code; typing it here lets
 * that device act as this Person, on this server, without their password ever leaving this
 * browser. Nothing is paired until the code is entered by someone who is already signed in.
 */
export function Devices({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode)
  const [outcome, setOutcome] = useState<Outcome>('idle')

  async function pair() {
    const result = await run(approveDevice(code.trim().toUpperCase()))
    setOutcome(Result.isSuccess(result) ? 'paired' : 'refused')
    if (Result.isSuccess(result)) setCode('')
  }

  return (
    <>
      <YourComputers />
      <SignedIn />
      <Pairing
        code={code}
        outcome={outcome}
        onCode={setCode}
        onOutcome={setOutcome}
        onPair={pair}
      />
    </>
  )
}

type Outcome = 'idle' | 'paired' | 'refused'

/** Typing in the code another device is showing, which signs that device in as this Person. */
function Pairing({
  code,
  outcome,
  onCode,
  onOutcome,
  onPair,
}: {
  code: string
  outcome: Outcome
  onCode: (code: string) => void
  onOutcome: (outcome: Outcome) => void
  onPair: () => Promise<void>
}) {
  return (
    <Section
      title="Sign in another device"
      detail="Open Vivid on your phone or the desktop app and choose “Sign in with a code”. Only sign in a code you can see on your own device: whoever holds that device gets your account."
    >
      <Row label="Code from the other device" detail="It looks like ABCD-EFGH.">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void onPair()
          }}
        >
          {/* A bare field, not `Input`: a code is read in the fixed-width face and shown in
              capitals however it is typed, and `Input` owns its typography. */}
          <input
            value={code}
            onChange={(event) => {
              onCode(event.currentTarget.value)
              onOutcome('idle')
            }}
            placeholder="ABCD-EFGH"
            autoCapitalize="characters"
            spellCheck={false}
            className="h-8 w-36 rounded-control bg-well px-3 font-mono text-label text-ink uppercase ring-line outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm" disabled={code.trim().length < 4}>
            Sign it in
          </Button>
        </form>
      </Row>
      {outcome === 'paired' && (
        <p className="px-4 py-3 text-label text-success">Done. That device is signed in as you.</p>
      )}
      {outcome === 'refused' && (
        <p role="alert" className="px-4 py-3 text-label text-danger">
          That code is not waiting, or it ran out. Ask the device for a new one.
        </p>
      )}
    </Section>
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
