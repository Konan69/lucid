import type { MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { Check, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { onboarding } from '../../data/onboarding'
import { finished, useProgress, type Step, type StepKind } from '../../data/progress'
import { router } from '../../data/route'
import { useAppearance } from '../../data/vivid'
import { cn } from '../../ui/cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdownmenu'
import { Customise } from '../vivid/Customise'

/** What each step is called. Vivid's name is the Person's to choose, so the title is told it. */
const TITLE = {
  connect: () => 'Connect what you use most',
  name: (vivid) => `Name ${vivid}`,
  text: (vivid) => `Text ${vivid} from your phone`,
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
  const [customising, setCustomising] = useState(false)

  // The steps close themselves when one is taken, so taking one is only going where it leads.
  const take = {
    connect: () => router.openSettings(Option.some('connections')),
    name: () => setCustomising(true),
    text: () => router.openSettings(Option.some('texting')),
  } satisfies Record<StepKind, () => void>

  return (
    <>
      {!over && Option.isSome(steps) && (
        <Control
          steps={steps.value}
          titleOf={(kind) => TITLE[kind](name)}
          onTake={(kind) => take[kind]()}
          onEnd={(how) => onboarding.end(me.person.id, how)}
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
  titleOf,
  onTake,
  onEnd,
}: {
  steps: ReadonlyArray<Step>
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
    <div className="mx-2 mb-2 motion-fade">
      {/* The steps are a menu the piece owns: nothing else reads whether it is open. It opens
          upward, over the piece and as wide as it, so it grows out of the whole control. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex h-(--row-h) w-full motion-press cursor-pointer items-center gap-2.5 rounded-control bg-surface-3 px-2.5 text-left lift select-none hover:bg-surface-2 focus-visible:edge-primary"
            />
          }
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
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" sideOffset={8} className="w-(--anchor-width)">
          {steps.map((step) => (
            // A title may wrap to two lines, so the tick sits on the first.
            <DropdownMenuItem
              key={step.kind}
              className="items-start"
              onClick={() => onTake(step.kind)}
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
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onEnd('dismissed')}>
            {/* In a box the size of a step's tick, so its words start where theirs do. */}
            <span className="inline-flex size-4 shrink-0 items-center justify-center">
              <X className="size-3.5" />
            </span>
            Don’t show this again
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
        className="stroke-primary motion-arc"
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
        done ? 'bg-primary text-primary-foreground' : 'edge edge-field',
      )}
    >
      {done && <Check className="size-3" strokeWidth={3} />}
    </span>
  )
}
