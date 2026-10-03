import type { MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { ArrowUpRight, ChevronRight, UserRound } from 'lucide-react'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { live, useLiveValue } from '../../data/live'
import { onboarding } from '../../data/onboarding'
import { mayCustomise, useAppearance } from '../../data/vivid'
import { Card } from '../../ui/Card'
import { Face } from '../../ui/Face'
import { Mark } from '../integration/Mark'
import { Customise } from '../vivid/Customise'
import { Checklist } from './Checklist'
import { readyOf, Uses } from './Uses'

/**
 * Vivid speaking first, in the Thread, to someone it has not met. There is no wizard
 * (`docs/23-product-definition.md`, "First run"): these are messages in the conversation, and
 * the Person can ignore every one of them and type.
 *
 * The shape is ChatGPT's dot's opening: a line saying who it is, a line saying what it does when
 * you are not talking, "Want to give me a name?" with a "Customize your dot ›" row under it, and
 * a last line asking what is top of mind. Vivid's differs in one place: where dot goes straight
 * to its name, Vivid first asks what the Person uses most, as one card that connects a service
 * where it stands, because an assistant with nothing connected has nothing of theirs to work on.
 *
 * These are drawn by this app, not stored in the conversation: the server has no way yet to
 * open a Thread with Vivid's own first words. They are shown on Home before the first Thread
 * exists and at the top of that first Thread afterwards, so what Vivid said does not vanish the
 * moment the Person answers it.
 *
 * Each item is an `li`, for the conversation's own list.
 */
export function Opening({ me, onSay }: { me: MeResponse; onSay: (words: string) => void }) {
  const { name } = useAppearance()
  const [customising, setCustomising] = useState(false)
  const over = useSyncExternalStore(onboarding.subscribe, () => onboarding.isOver(me.person.id))
  const first = me.person.name.trim().split(/\s+/u)[0]
  const connections = useLiveValue(live.connections)
  const connected = readyOf(
    Option.match(connections, { onNone: () => [], onSome: (value) => value.connections }),
  ).map((connection) => connection.serviceName)
  const jobs = connected.flatMap((service) => {
    const known = JOBS.get(service.trim().toLocaleLowerCase())
    return known === undefined ? [] : known.map((job) => ({ job, service }))
  })
  return (
    <>
      <Said order={0} face>
        <Bubble>
          {first === undefined || first.length === 0
            ? `Hey! I’m ${name}.`
            : `Hey ${first}! I’m ${name}.`}
        </Bubble>
        <Bubble>
          I chase what you’re waiting on, do jobs on my own computer, keep your projects moving and
          sort out your time. Message me anytime. I check in when I have an update or a question.
        </Bubble>
      </Said>
      <Said order={1}>
        <Card className="p-4">
          <h2 className="text-title font-title text-ink">What do you use most?</h2>
          <p className="mt-0.5 mb-3 text-label text-pretty text-ink-3">
            {connected.length === 0
              ? 'Mail and calendar first, then files and chat. You sign in on the service’s own page; I never see your password.'
              : `${connected.join(', ')} connected. Add anything else you use.`}
          </p>
          <Uses />
        </Card>
      </Said>
      {jobs.length > 0 && (
        <Said order={2}>
          <Bubble>Here is where I can start:</Bubble>
          <ul className="grid gap-2 sm:grid-cols-2">
            {jobs.map(({ job, service }) => (
              <li key={`${service}:${job.title}`}>
                <Suggested job={job} service={service} onPress={() => onSay(job.words)} />
              </li>
            ))}
          </ul>
        </Said>
      )}
      {mayCustomise(me) && (
        <Said order={2}>
          <Bubble>Want to give me a name and a look?</Bubble>
          <button
            type="button"
            onClick={() => setCustomising(true)}
            aria-haspopup="dialog"
            className="inline-flex h-10 w-fit motion-press cursor-pointer items-center gap-2 rounded-full bg-surface-3 pr-3 pl-3.5 text-body text-accent-ink edge edge-field hover:bg-surface-2 focus-visible:edge-accent"
          >
            <UserRound aria-hidden className="size-4" />
            Customise {name}
            <ChevronRight aria-hidden className="size-4" />
          </button>
        </Said>
      )}
      {!over && (
        <Said order={3}>
          <Checklist me={me} beside />
        </Said>
      )}
      {customising && <Customise onClose={() => setCustomising(false)} />}
    </>
  )
}

/** How far each of Vivid's opening items waits before it rises in: its place in the order. */
const ORDER = ['[--order:0]', '[--order:2]', '[--order:4]', '[--order:6]'] as const

/**
 * One thing Vivid says, in the conversation's column: its face beside the first, and the same
 * gutter under the rest, so cards and bubbles line up with its replies in a real Thread.
 */
function Said({
  order,
  face = false,
  children,
}: {
  order: 0 | 1 | 2 | 3
  face?: boolean
  children: ReactNode
}) {
  return (
    <li className={`flex motion-enter gap-3 ${ORDER[order]}`}>
      {face ? (
        <Face size={28} className="mt-0.5" mood="happy" />
      ) : (
        <span className="w-7 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </li>
  )
}

/** A few of Vivid's words, in the bubble its short replies use in a Thread. */
function Bubble({ children }: { children: ReactNode }) {
  return (
    <p className="w-fit max-w-bubble rounded-composer rounded-tl-sm bg-surface-2 px-4 py-2.5 text-body text-pretty text-ink">
      {children}
    </p>
  )
}

/** A job Vivid can start on at once with one connected service, in words to send to it. */
interface Job {
  readonly title: string
  /** The sentence around the service's name: "Finds what nobody answered in [Gmail] …". */
  readonly before: string
  readonly after: string
  readonly words: string
}

/**
 * The jobs offered for each service, by the service's exact catalog name, in the order of what
 * makes Vivid worth opening (`docs/23-product-definition.md`): chasing what the Person is
 * waiting on first, then their time. Each is one of Vivid's built-in skills
 * (`packages/agent/skills`: chase-an-outcome, triage-my-inbox, find-time-and-schedule,
 * prepare-for-a-meeting), so a card promises only what Vivid already knows how to do. A service
 * with no entry gets no suggestion: nothing generic is shown in its place.
 */
const JOBS = new Map<string, ReadonlyArray<Job>>([
  [
    'gmail',
    [
      {
        title: 'Chase what I’m waiting on',
        before: 'Finds what nobody answered in',
        after: 'and chases it for you',
        words:
          'Look through my email for things I am still waiting on a reply to. Tell me which ones to chase, and draft the chasers for me to check.',
      },
      {
        title: 'Inbox triage',
        before: 'Reads',
        after: 'and tells you what needs you',
        words: 'Triage my inbox: what needs me today, and what can wait?',
      },
    ],
  ],
  [
    'google calendar',
    [
      {
        title: 'Organise my week',
        before: 'Reads',
        after: 'and gives you a plan and your to-dos',
        words:
          'Look at my calendar for this week. Tell me what is coming, what to prepare, and give me a to-do list.',
      },
      {
        title: 'Prepare for a meeting',
        before: 'Briefs you before your next meeting in',
        after: '',
        words:
          'Prepare me for my next meeting: who is in it, what it is about, and what I should bring.',
      },
    ],
  ],
])

/** One suggested job: its name, and a sentence with the service's logo and name set in it. */
function Suggested({ job, service, onPress }: { job: Job; service: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="group/job flex size-full motion-press cursor-pointer items-start gap-3 rounded-card bg-surface-3 p-3.5 text-left edge hover:bg-surface-2 hover:edge-field focus-visible:edge-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-title font-title text-ink">{job.title}</span>
        <span className="mt-1 block text-label leading-6 text-pretty text-ink-3">
          {job.before}{' '}
          <span className="inline-flex items-center gap-1 rounded-row bg-surface-2 py-0.5 pr-1.5 pl-0.5 align-middle font-title text-ink">
            <Mark service={{ name: service }} size={18} className="rounded-xs text-meta" />
            {service}
          </span>{' '}
          {job.after}
        </span>
      </span>
      <ArrowUpRight
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-ink-4 transition-colors duration-(--dur-fast) group-hover/job:text-accent-ink"
      />
    </button>
  )
}
