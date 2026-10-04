import type { MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { Check, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { onboarding } from '../../data/onboarding'
import { finished, useProgress, type Step, type StepKind } from '../../data/progress'
import { router } from '../../data/route'
import { useAppearance } from '../../data/vivid'
import { cn } from '../../ui/cn'
import { Menu, MenuDivider, MenuItem } from '../../ui/Menu'
import { Customise } from '../vivid/Customise'

/** What each step is called. Vivid's name is the Person's to choose, so the title is told it. */
const TITLE = {
  connect: () => 'Connect what you use most',
  name: (vivid) => `Name ${vivid}`,
} satisfies Record<StepKind, (vivid: string) => string>

/**
 * What is left of getting started, as one small floating piece at the foot of the sidebar: a
 * progress ring, "Getting started" and how far along it is. Pressing it opens the steps over it.
 *
 * It used to be a card of rows in the conversation, and that was too much on a first screen: the
 * conversation is for Vivid and the Person, and setup is a thing to glance at. The pattern is the
 * reference assistant's (Grok Bot keeps one small "Connect apps" pill at the foot of its sidebar
 * and nothing about setup in the conversation). Vivid's holds more than one step, so it is a ring
 * with a count and opens a short list.
 *
 * It is raised (its own fill, an edge and the floating shadow) because it is not a place in the
 * rail like the rows above it: it sits over the rail, and it leaves. The steps grow out of it,
 * from its top edge, in the menu's own motion.
 *
 * It is not a wizard. Nothing waits on it and every step can be taken in any order or not at
 * all. Each is read from real state (`useProgress`), so doing the thing anywhere ticks it here.
 * It leaves for good when every step is done or when it is closed.
 */
export function Started({ me }: { me: MeResponse }) {
  const steps = useProgress(me)
  const over = useSyncExternalStore(onboarding.subscribe, () => onboarding.isOver(me.person.id))
  const { name } = useAppearance()
  const [open, setOpen] = useState(false)
  const [customising, setCustomising] = useState(false)

  const take = {
    connect: () => {
      setOpen(false)
      router.openSettings(Option.some('connections'))
    },
    name: () => {
      setOpen(false)
      setCustomising(true)
    },
  } satisfies Record<StepKind, () => void>

  return (
    <>
      {!over && Option.isSome(steps) && (
        <Control
          steps={steps.value}
          open={open}
          onOpen={setOpen}
          titleOf={(kind) => TITLE[kind](name)}
          onTake={(kind) => take[kind]()}
          onEnd={(how) => {
            setOpen(false)
            onboarding.end(me.person.id, how)
          }}
        />
      )}
      {/* Outside the control: naming Vivid can be the last step, and the dialog must not be
          taken away with the control the moment the new name arrives. */}
      {customising && <Customise onClose={() => setCustomising(false)} />}
    </>
  )
}

/** The floating piece itself and the steps that open over it, for a list that is not over. */
function Control({
  steps,
  open,
  onOpen,
  titleOf,
  onTake,
  onEnd,
}: {
  steps: ReadonlyArray<Step>
  open: boolean
  onOpen: (open: boolean) => void
  titleOf: (kind: StepKind) => string
  onTake: (kind: StepKind) => void
  onEnd: (how: 'finished' | 'dismissed') => void
}) {
  if (finished(steps)) {
    // Finishing is remembered where it is noticed, so the list does not come back if a step is
    // later undone. `end` is idempotent. It tells this component's own subscription, which React
    // does not allow in the middle of a render, so it is said just after this one.
    queueMicrotask(() => onEnd('finished'))
    return null
  }
  const done = steps.filter((step) => step.done).length
  return (
    <div className="relative mx-2 mb-2 motion-fade">
      <button
        type="button"
        onClick={() => onOpen(true)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-(--row-h) w-full motion-press cursor-pointer items-center gap-2.5 rounded-control bg-surface-3 px-2.5 text-left lift select-none hover:bg-surface-2 focus-visible:edge-accent"
      >
        <Ring done={done} of={steps.length} />
        <span className="min-w-0 flex-1 truncate text-label font-title text-ink">
          Getting started
        </span>
        <span className="shrink-0 text-meta font-meta text-ink-3 tabular-nums">
          {/* The count steps up when a step is taken; the key makes it a new number. */}
          <span key={done} className="motion-tick">
            {done}
          </span>{' '}
          of {steps.length}
        </span>
      </button>
      <Menu open={open} onClose={() => onOpen(false)} side="over">
        {steps.map((step) => (
          <button
            key={step.kind}
            type="button"
            role="menuitem"
            onClick={() => onTake(step.kind)}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded-row px-2.5 py-2 text-left transition-colors duration-(--dur-fast) outline-none select-none hover:bg-wash-hover focus-visible:bg-wash-hover active:bg-wash-pressed"
          >
            <Tick done={step.done} />
            <span
              className={cn(
                'min-w-0 flex-1 text-label text-pretty',
                step.done ? 'text-ink-3' : 'text-ink',
              )}
            >
              {titleOf(step.kind)}
              {step.done && <span className="sr-only"> (done)</span>}
            </span>
          </button>
        ))}
        <MenuDivider />
        <MenuItem icon={<X className="size-3.5" />} onSelect={() => onEnd('dismissed')}>
          Don’t show this again
        </MenuItem>
      </Menu>
    </div>
  )
}

/**
 * How far along the list is, as an arc round a small ring. It is drawn once and holds; when a
 * step is taken the arc grows to its new length and stops. The length is a stroke's dash, which
 * is painted and not laid out, on a 16px mark a handful of times in a Person's life.
 */
function Ring({ done, of }: { done: number; of: number }) {
  return (
    // Turned a quarter back so the arc starts at the top, where a clock's hand does.
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth="2"
      className="size-4 shrink-0 -rotate-90"
    >
      <circle cx="8" cy="8" r="6" className="stroke-line-4" />
      {/* `pathLength` makes the circle as long as there are steps, so the dash is the count. */}
      <circle
        cx="8"
        cy="8"
        r="6"
        pathLength={of}
        strokeDasharray={`${done} ${of}`}
        // A round end is drawn even on a dash of no length, as a dot; nothing done shows nothing.
        strokeLinecap={done === 0 ? 'butt' : 'round'}
        className="stroke-accent motion-arc"
      />
    </svg>
  )
}

/** The mark at the head of a step: an empty ring to do, a filled tick once done. */
function Tick({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        // Sits on the first line of a title that may wrap to two.
        'mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full',
        done ? 'bg-accent text-ink-on-accent' : 'edge edge-field',
      )}
    >
      {done && <Check className="size-3" strokeWidth={3} />}
    </span>
  )
}
