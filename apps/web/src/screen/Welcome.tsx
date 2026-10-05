import { Option, Result } from 'effect'
import { Check } from 'lucide-react'
import { useId, useState, useSyncExternalStore, type FormEvent } from 'react'
import {
  adoptFirstArrival,
  continueWithGoogle,
  createAccount,
  reload,
  signIn,
} from '../data/account'
import { run, send } from '../data/app'
import { readAddress, SAID, Standing } from '../data/google'
import { googleHandoff } from '../data/handoff'
import { Way } from '../data/signin'
import { Button } from '../ui/button'
import { Face } from '../ui/Face'
import { Field, FieldDescription, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { GoogleWay } from './welcome/Google'
import { Waiting } from './welcome/Waiting'

type Mode = 'create' | 'enter'

const COPY = {
  create: {
    title: 'Meet Vivid.',
    lead: 'One teammate that remembers, follows up, and gets things done for you.',
    action: 'Create account',
    other: 'I already have an account',
  },
  enter: {
    title: 'Welcome back.',
    lead: 'Pick up where you and Vivid left off.',
    action: 'Sign in',
    other: 'Create an account',
  },
} satisfies Record<Mode, { title: string; lead: string; action: string; other: string }>

/** What Vivid does, said the way it would say it. Shown beside the form on a wide window. */
const PROMISES = [
  'Remembers what matters to you, and forgets what you tell it to.',
  'Follows up on its own, so nothing waits on you to chase it.',
  'Works in the tools you already use, on a computer of its own.',
  'Asks first before anything that sends, spends or deletes.',
] as const

/** What the form says back: a fault in the danger ink, or a quiet word about what the Person chose. */
interface Notice {
  readonly tone: 'danger' | 'quiet'
  readonly message: string
}

const TONE = { danger: 'text-danger', quiet: 'text-ink-3' } satisfies Record<Notice['tone'], string>

/**
 * The form's one sentence. A fault is an alert, said as soon as it appears; a quiet word is a
 * status, said when the screen reader is next free. It wraps: nothing here is ever cut short.
 */
function Said({ notice }: { notice: Notice }) {
  return (
    <p
      role={notice.tone === 'danger' ? 'alert' : 'status'}
      className={`text-label text-pretty ${TONE[notice.tone]}`}
    >
      {notice.message}
    </p>
  )
}

/** Which request is on its way. One at a time: both buttons rest while either is. */
type Busy = 'none' | 'email' | 'google'

/**
 * How Google sign-in happens in this window (`Way`). In a browser the page leaves for Google and
 * comes back signed in. In the desktop app it cannot, because Google refuses to sign anyone in
 * inside an embedded window, so the same button opens their system browser on Google and this
 * window waits for the account they choose there (`data/handoff.ts`). A desktop app too old to
 * do that offers no button at all, and says what would bring it.
 */
const GOOGLE = googleHandoff.way
const GOOGLE_HERE = Way.$is('Browser')(GOOGLE)

// The landing of a first sign-in with Google is a page load like any other, and by then somebody
// is signed in, so no welcome is drawn to notice it. This module is loaded with the app, which
// makes here the one place that runs on that load. It does nothing on every other address.
void send(adoptFirstArrival)

/** How the welcome opens: which form, what it already has to say, and whether Google starts. */
interface Opening {
  readonly destination: string
  readonly mode: Mode
  readonly notice: Notice | null
  readonly starting: boolean
}

/**
 * Reads how to open from the address (`data/google.ts`). A plain address opens on the new-account
 * form with nothing said. One that came back from Google says why, and when the reason is an
 * account that already has a password it opens on signing in, because that is what to do next.
 */
const opening = (returnTo: string): Opening => {
  const { destination, standing } = readAddress(returnTo)
  return Standing.$match(standing, {
    Plain: (): Opening => ({ destination, mode: 'create', notice: null, starting: false }),
    // An address that asks for Google is one a phone opened in a browser. It starts by itself
    // only there: in the desktop app nothing opens such an address.
    Start: (): Opening => ({ destination, mode: 'create', notice: null, starting: GOOGLE_HERE }),
    Returned: ({ outcome }): Opening => ({
      destination,
      mode: outcome === 'NotLinked' ? 'enter' : 'create',
      notice: SAID[outcome],
      starting: false,
    }),
  })
}

/**
 * Who Vivid is: its face, one line that changes with the form beside it, and on a wide window
 * what it does. It is the half of the welcome that asks for nothing.
 */
function Introduction({ title, lead }: { title: string; lead: string }) {
  return (
    <div>
      <span className="relative inline-flex">
        <span aria-hidden className="pointer-events-none absolute -inset-12 aura" />
        <Face size={72} mood="happy" className="relative" />
      </span>
      <h1 className="mt-7 font-display text-display font-strong tracking-display text-balance text-ink">
        {title}
      </h1>
      <p className="mt-3 max-w-sm text-section text-ink-3">{lead}</p>
      <ul className="mt-8 hidden flex-col gap-3 md:flex">
        {PROMISES.map((promise) => (
          <li key={promise} className="flex items-start gap-3 text-body text-ink-2">
            <Check className="mt-1 size-4 shrink-0 text-primary-ink" strokeWidth={2.25} />
            {promise}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The first thing anyone sees: who Vivid is, and one short form. There is nothing to configure
 * and nothing to choose; an account opens straight onto the first Thread, in the Person's own
 * space. `returnTo` is where they were going (an invitation link, a device to approve), so signing
 * in is a step on the way and not a detour.
 *
 * There are two ways in. The form, for an email and a password, and Google, which is one button
 * for a new Person and a returning one alike. The address can also say something about Google:
 * that it should start at once, which is how the phone hands a Person over to the browser, or
 * that it was tried and did not work, and why.
 *
 * In the desktop app Google is the same button with a different road: the form's card gives way
 * to a waiting card while the Person chooses an account in their browser (`welcome/Waiting.tsx`).
 * Cancelling it draws the form again, with the keyboard in its first field.
 */
export function Welcome({ returnTo }: { returnTo: string }) {
  const opened = opening(returnTo)
  const { destination } = opened
  const [mode, setMode] = useState(opened.mode)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState(opened.notice)
  const [busy, setBusy] = useState<Busy>(opened.starting ? 'google' : 'none')
  const handoff = useSyncExternalStore(googleHandoff.subscribe, googleHandoff.current)
  const copy = COPY[mode]

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy('email')
    setNotice(null)
    const request =
      mode === 'create'
        ? createAccount({ name: name.trim(), email: email.trim(), password })
        : signIn({ email: email.trim(), password })
    const result = await run(request)
    if (Result.isFailure(result)) {
      setNotice({ tone: 'danger', message: result.failure.message })
      setBusy('none')
      return
    }
    reload(destination)
  }

  /**
   * Leaves for Google. When this works the page is already on its way out, so the button stays
   * at rest and says so; only a refusal brings it back (and see `reloadOnReturn`).
   *
   * In the desktop app nothing leaves: the hand-off starts and its card takes the form's place.
   */
  async function google() {
    setNotice(null)
    if (!GOOGLE_HERE) {
      googleHandoff.start(destination)
      return
    }
    setBusy('google')
    reloadOnReturn()
    const result = await run(continueWithGoogle(destination))
    if (Result.isFailure(result)) {
      setNotice(SAID[result.failure.outcome])
      setBusy('none')
    }
  }

  return (
    // Two halves on a wide window: who Vivid is on the left, the one short form on the right.
    // Stacked on a narrow one, with the form within reach of the thumb.
    //
    // The content is centred by its own margins, not by the scrolling box: a box that centres
    // content taller than itself puts the top of it above where scrolling can reach, and on a
    // short phone the welcome is taller than the screen.
    <main className="flex size-full overflow-y-auto bg-surface-0 px-6 py-10">
      <div className="m-auto grid w-full max-w-4xl animate-rise-in items-center gap-10 md:grid-cols-2 md:gap-16">
        <Introduction title={copy.title} lead={copy.lead} />

        <div className="w-full max-w-sm justify-self-center md:justify-self-end">
          {Option.isSome(handoff) ? (
            <Waiting
              state={handoff.value}
              onReopen={googleHandoff.reopen}
              onAgain={() => googleHandoff.start(destination)}
              onCancel={googleHandoff.cancel}
            />
          ) : (
            <>
              <form
                onSubmit={(event) => {
                  void submit(event)
                }}
                className="flex flex-col gap-3 rounded-panel bg-surface-3 p-6 edge"
              >
                {mode === 'create' && (
                  <Entry
                    label="Your name"
                    value={name}
                    onChange={setName}
                    autoComplete="name"
                    autoFocus
                  />
                )}
                <Entry
                  label="Email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  autoComplete="email"
                  autoFocus={mode === 'enter'}
                />
                <Entry
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                  hint={mode === 'create' ? 'At least 8 characters.' : undefined}
                />
                {notice !== null && <Said notice={notice} />}
                <Button type="submit" disabled={busy !== 'none'} className="mt-1 w-full">
                  {busy === 'email' ? 'One moment…' : copy.action}
                </Button>
                <GoogleChoice
                  destination={destination}
                  starting={opened.starting}
                  resting={busy !== 'none'}
                  leaving={busy === 'google'}
                  onStart={() => {
                    void google()
                  }}
                />
              </form>

              <Other
                label={copy.other}
                resting={busy !== 'none'}
                onPress={() => {
                  setMode(mode === 'create' ? 'enter' : 'create')
                  setNotice(null)
                }}
              />
            </>
          )}
        </div>
      </div>
    </main>
  )
}

/**
 * Google, under the form: the button, or in a desktop app too old to hand the Person to a
 * browser, one line saying what would bring it. A button that cannot work is not offered.
 */
function GoogleChoice(props: Parameters<typeof GoogleWay>[0]) {
  return Way.$is('Outdated')(GOOGLE) ? (
    <p className="text-center text-label text-pretty text-ink-3">
      Update Vivid to sign in with Google here.
    </p>
  ) : (
    <GoogleWay {...props} />
  )
}

/**
 * A browser that keeps a page whole and shows it again on Back would show the welcome as it was
 * left for Google: its button at rest for ever, saying it is opening Google. Such a return loads
 * the page afresh instead.
 */
const reloadOnReturn = () =>
  addEventListener(
    'pageshow',
    (event) => {
      if (event.persisted) location.reload()
    },
    { once: true },
  )

/**
 * The other way in, said quietly under the form: a ghost button, centred. It rests while a
 * request is on its way, because the form it answers must still be the one shown.
 */
function Other({
  label,
  resting,
  onPress,
}: {
  label: string
  resting: boolean
  onPress: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={resting}
      onClick={onPress}
      className="mx-auto mt-4 flex w-fit"
    >
      {label}
    </Button>
  )
}

/**
 * One line of the form: its label, the field, and a hint under it when it has one. The label is
 * tied to the field by id, and the hint is the field's description, so a screen reader says
 * "At least 8 characters." with the password field and not as loose text after it.
 */
function Entry({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  autoFocus = false,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'password'
  autoComplete: string
  autoFocus?: boolean
  hint?: string
}) {
  const id = useId()
  const hintId = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        required
        type={type}
        value={value}
        minLength={type === 'password' ? 8 : undefined}
        autoComplete={autoComplete}
        aria-describedby={hint === undefined ? undefined : hintId}
        // The form is the whole screen; focusing its first field is what the Person came to do.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint !== undefined && <FieldDescription id={hintId}>{hint}</FieldDescription>}
    </Field>
  )
}
