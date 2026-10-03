import { Result } from 'effect'
import { Check } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { createAccount, reload, signIn } from '../data/account'
import { run } from '../data/app'
import { Button } from '../ui/Button'
import { Face } from '../ui/Face'

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

/**
 * The first thing anyone sees: who Vivid is, and one short form. There is nothing to configure
 * and nothing to choose; an account opens straight onto the first Thread, in the Person's own
 * space. `returnTo` is where they were going (an invitation link, a device to approve), so signing
 * in is a step on the way and not a detour.
 */
export function Welcome({ returnTo }: { returnTo: string }) {
  const [mode, setMode] = useState<Mode>('create')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const copy = COPY[mode]

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setRefusal(null)
    const request =
      mode === 'create'
        ? createAccount({ name: name.trim(), email: email.trim(), password })
        : signIn({ email: email.trim(), password })
    const result = await run(request)
    if (Result.isFailure(result)) {
      setRefusal(result.failure.message)
      setBusy(false)
      return
    }
    reload(returnTo)
  }

  return (
    // Two halves on a wide window: who Vivid is on the left, the one short form on the right.
    // Stacked on a narrow one, with the form within reach of the thumb.
    <main className="flex size-full items-center justify-center overflow-y-auto bg-surface-0 px-6 py-10">
      <div className="grid w-full max-w-4xl animate-rise-in items-center gap-10 md:grid-cols-2 md:gap-16">
        <div>
          <span className="relative inline-flex">
            <span aria-hidden className="pointer-events-none absolute -inset-12 aura" />
            <Face size={72} mood="happy" className="relative" />
          </span>
          <h1 className="mt-7 font-display text-display font-strong tracking-display text-balance text-ink">
            {copy.title}
          </h1>
          <p className="mt-3 max-w-sm text-section text-ink-3">{copy.lead}</p>
          <ul className="mt-8 hidden flex-col gap-3 md:flex">
            {PROMISES.map((promise) => (
              <li key={promise} className="flex items-start gap-3 text-body text-ink-2">
                <Check className="mt-1 size-4 shrink-0 text-accent-ink" strokeWidth={2.25} />
                {promise}
              </li>
            ))}
          </ul>
        </div>

        <div className="w-full max-w-sm justify-self-center md:justify-self-end">
          <form
            onSubmit={(event) => {
              void submit(event)
            }}
            className="flex flex-col gap-3 rounded-panel bg-surface-3 p-6 edge"
          >
            {mode === 'create' && (
              <Field
                label="Your name"
                value={name}
                onChange={setName}
                autoComplete="name"
                autoFocus
              />
            )}
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              autoFocus={mode === 'enter'}
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              hint={mode === 'create' ? 'At least 8 characters.' : undefined}
            />
            {refusal !== null && (
              <p role="alert" className="text-label text-danger">
                {refusal}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full">
              {busy ? 'One moment…' : copy.action}
            </Button>
          </form>

          <button
            type="button"
            onClick={() => {
              setMode(mode === 'create' ? 'enter' : 'create')
              setRefusal(null)
            }}
            className="mx-auto mt-4 block cursor-pointer rounded-control px-2 py-1 text-label text-ink-3 transition-colors duration-(--dur-fast) hover:text-ink"
          >
            {copy.other}
          </button>
        </div>
      </div>
    </main>
  )
}

function Field({
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
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-label text-ink-2">{label}</span>
      <input
        required
        type={type}
        value={value}
        minLength={type === 'password' ? 8 : undefined}
        autoComplete={autoComplete}
        // The form is the whole screen; focusing its first field is what the Person came to do.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-control bg-well px-3 text-body text-ink ring-line transition-surface duration-(--dur-fast) outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
      />
      {hint !== undefined && <span className="text-meta font-meta text-ink-3">{hint}</span>}
    </label>
  )
}
