import { RunOutcome, RunState, RunUncertainty, type Run, type RunFailure } from '@vivid/contracts'
import { Option } from 'effect'

/**
 * What to tell a Person about a Run that did not end with an answer, and whether asking again can
 * help. One sentence each, in the order: what happened, what to do. A model that cannot be reached
 * is not something asking again fixes, so that one offers nothing to press.
 */
const FAILED = {
  Delivery: { words: 'Vivid could not start on that. Send it again.', again: true },
  RateLimited: { words: 'Vivid’s model is busy. Give it a moment, then try again.', again: true },
  ModelUnavailable: {
    words: 'Vivid’s model can’t be reached. Whoever runs this Vivid needs to look at it.',
    again: false,
  },
  NoAnswer: { words: 'Vivid came back with nothing to say.', again: true },
  TimedOut: { words: 'Vivid took too long and stopped.', again: true },
  Unexplained: { words: 'Vivid couldn’t finish that.', again: true },
} satisfies Record<RunFailure, { words: string; again: boolean }>

const LOST = {
  words: 'Vivid lost track of this one, so it may not have finished.',
  again: true,
}

/**
 * A Run sent something to a service and never heard back. Asking again could do it twice, so
 * there is nothing to press: the server holds the same action until its result is known.
 */
const UNHEARD = {
  words: 'Vivid didn’t hear back, so the result of that action isn’t known yet.',
  again: false,
}

/** The newest Run in a Thread, which is the one whose ending the Person is waiting on. */
export const newestRun = (runs: ReadonlyArray<Run>) =>
  runs.reduce<Option.Option<Run>>(
    (newest, run) =>
      Option.isSome(newest) && newest.value.startedAt >= run.startedAt ? newest : Option.some(run),
    Option.none(),
  )

/** Whether a Run's outcome is an outward action whose result is not known. */
const unheard = (run: Run) =>
  run.outcome !== null &&
  RunOutcome.guards.Unknown(run.outcome) &&
  RunUncertainty.guards.Action(run.outcome.uncertainty)

/** What a Run's ending needs said, when it needs anything said at all. */
const sayingOf = (run: Run) => (unheard(run) ? Option.some(UNHEARD) : endingOf(run.state))

/** How execution ended, which says nothing when it ended with an answer or was stopped. */
const endingOf = (state: RunState) =>
  RunState.match(state, {
    Working: () => Option.none(),
    Completed: () => Option.none(),
    Stopped: () => Option.none(),
    Failed: ({ reason }) => Option.some(FAILED[reason]),
    Unknown: () => Option.some(LOST),
  })

/**
 * The end of a Run that produced no answer, said where the answer would have been. It reads from
 * the Run the server recorded, not from this page's own send, so a Thread reopened tomorrow, or
 * watched by someone else, says the same thing.
 */
export function Outcome({ run, onAgain }: { run: Run; onAgain: Option.Option<() => void> }) {
  const saying = sayingOf(run)
  if (Option.isNone(saying)) return null
  return (
    <li className="flex animate-fade-in items-baseline gap-3 pl-9 text-label text-ink-3">
      <span className="min-w-0">{saying.value.words}</span>
      {saying.value.again && Option.isSome(onAgain) && (
        <button
          onClick={onAgain.value}
          className="shrink-0 cursor-pointer rounded-xs text-ink-2 underline decoration-line-4 underline-offset-4 transition-colors duration-(--dur-fast) hover:text-ink hover:decoration-ink-3 focus-visible:text-ink"
        >
          Try again
        </button>
      )}
    </li>
  )
}
