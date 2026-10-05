import { makeWhen, spellCode, thisReader } from '@vivid/state'
import { Option, Result } from 'effect'
import { Suspense, use, useId, useState } from 'react'
import {
  approveDevice,
  denyDevice,
  openDevice,
  signedInDevices,
  signOutDevice,
  signOutElsewhere,
  type AccountRefused,
  type SignedInDevice,
  type SignInRequest,
} from '../../data/account'
import { run } from '../../data/app'
import { Button } from '../../ui/button'
import { YourComputers } from './Computers'
import { Empty, Refusal, Row, Section } from './Parts'

/**
 * Signing in a phone. The phone shows a short code; entering it here lets that phone act as this Person, on this server, without their password ever leaving this
 * browser. Nothing is signed in until someone who is already signed in has seen what is asking
 * and said yes.
 *
 * It takes two steps on purpose. A code can arrive in a link (`/device?user_code=…`), and a link
 * can come from anyone: someone who started a sign-in on their own device could send theirs and
 * be signed in as whoever pressed one button. So the code is first opened and shown for what it
 * is (which kind of app asked, the code as that app shows it, what approving does), and only
 * then is there anything to approve, beside a way to say it was not them.
 */
export function Devices({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode)
  const [outcome, setOutcome] = useState<Outcome>('idle')
  const [request, setRequest] = useState<Option.Option<SignInRequest>>(Option.none())
  const [busy, setBusy] = useState(false)

  /** Runs one step, with the buttons at rest while it is on its way. */
  async function step<Value>(program: Parameters<typeof run<Value, AccountRefused>>[0]) {
    setBusy(true)
    const result = await run(program)
    setBusy(false)
    return result
  }

  async function look() {
    const result = await step(openDevice(code))
    setOutcome(Result.isSuccess(result) ? 'idle' : 'refused')
    setRequest(Result.isSuccess(result) ? Option.some(result.success) : Option.none())
  }

  /** Sends the decision, then goes back to the empty field with what happened said under it. */
  async function decide(made: ReturnType<typeof approveDevice>, done: Outcome) {
    const result = await step(made)
    setOutcome(Result.isSuccess(result) ? done : 'refused')
    setRequest(Option.none())
    setCode('')
  }

  return (
    <>
      <YourComputers />
      <SignedIn />
      <Section
        title="Sign in another device"
        detail="Open Vivid on your phone and choose “Sign in with a code”."
      >
        {Option.isSome(request) ? (
          <Deciding
            request={request.value}
            resting={busy}
            onApprove={() => void decide(approveDevice(request.value), 'paired')}
            onDeny={() => void decide(denyDevice(request.value), 'denied')}
          />
        ) : (
          <Entering
            code={code}
            resting={busy}
            onCode={(next) => {
              setCode(next)
              setOutcome('idle')
            }}
            onLook={look}
          />
        )}
        <Said outcome={outcome} />
      </Section>
    </>
  )
}

type Outcome = 'idle' | 'paired' | 'denied' | 'refused'

/** What the section says about the last thing that happened in it. Nothing, until something has. */
function Said({ outcome }: { outcome: Outcome }) {
  if (outcome === 'paired')
    return <p className="px-4 py-3 text-label text-success">Done. That app is signed in as you.</p>
  if (outcome === 'denied')
    return (
      <p role="status" className="px-4 py-3 text-label text-ink-2">
        Nothing was signed in. That request was turned down.
      </p>
    )
  if (outcome === 'refused')
    return (
      <p role="alert" className="px-4 py-3 text-label text-danger">
        That code is not waiting, or it ran out. Ask the device for a new one.
      </p>
    )
  return null
}

/**
 * The first step: the code another device is showing, typed or already filled in from a link.
 * "Continue" opens it to be looked at; it signs nothing in.
 */
function Entering({
  code,
  resting,
  onCode,
  onLook,
}: {
  code: string
  resting: boolean
  onCode: (code: string) => void
  onLook: () => Promise<void>
}) {
  return (
    <Row label="Code from the other device" detail="It looks like ABCD-EFGH.">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void onLook()
        }}
      >
        {/* A bare field, not `Input`: a code is read in the fixed-width face and shown in
            capitals however it is typed, and `Input` owns its typography. */}
        <input
          value={code}
          onChange={(event) => onCode(event.currentTarget.value)}
          placeholder="ABCD-EFGH"
          aria-label="Code from the other device"
          autoCapitalize="characters"
          spellCheck={false}
          className="h-8 w-36 rounded-control bg-well px-3 font-mono text-label text-ink uppercase ring-line outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" disabled={resting || code.trim().length < 4}>
          Continue
        </Button>
      </form>
    </Row>
  )
}

/**
 * Takes the keyboard to the request when it replaces the field, so a screen reader says what is
 * asking before the buttons, and Tab goes on to them. A constant, so React calls it once.
 */
const focusRequest = (request: HTMLElement | null) => {
  if (request !== null) request.focus()
}

/**
 * The second step: what is asking, and the decision. It says which kind of app asked (a label
 * the app gave, so it is worded as a kind and never as "your" app), shows the code large and in
 * two halves exactly as that app shows it, and says in one sentence what approving does and when
 * to do it. The code matching the device in the Person's hand is the only proof there is that
 * this request is theirs, which is why it is the largest thing here.
 *
 * "Sign it in" is the one filled button. "Not me" is beside it at the same size, an outlined
 * control and not a quiet link, because for someone sent this by a stranger it is the right
 * answer and must be as easy to press.
 */
function Deciding({
  request,
  resting,
  onApprove,
  onDeny,
}: {
  request: SignInRequest
  resting: boolean
  onApprove: () => void
  onDeny: () => void
}) {
  const title = useId()
  const warning = useId()
  return (
    <div
      ref={focusRequest}
      tabIndex={-1}
      role="group"
      aria-labelledby={title}
      aria-describedby={warning}
      className="flex flex-col gap-3 p-4 outline-none"
    >
      <p id={title} className="text-title font-title text-balance text-ink">
        {request.asker} wants to sign in as you
      </p>
      <p className="w-fit rounded-control bg-well px-4 py-3 font-mono text-page tracking-widest text-ink tabular-nums">
        {spellCode(request.code)}
      </p>
      <p id={warning} className="max-w-prose text-label text-pretty text-ink-2">
        Approving signs that app in to your account. Only approve if you started this yourself and
        the code matches the one on your device.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={resting} onClick={onApprove}>
          Sign it in
        </Button>
        <Button size="sm" variant="outline" disabled={resting} onClick={onDeny}>
          Not me
        </Button>
      </div>
    </div>
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
