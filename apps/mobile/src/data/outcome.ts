import { RunOutcome, RunState, RunUncertainty, type Run, type RunFailure } from '@vivid/contracts'
import { Option } from 'effect'

/**
 * How a Run that produced no answer ended, in words. Pure functions over the Runs the Thread's
 * live detail carries; the screen only draws what these return.
 *
 * It reads from the Run the server recorded, not from this phone's own send, so a Thread reopened
 * tomorrow, or watched by someone else, says the same thing. The words are the web's
 * (`apps/web/src/screen/thread/Outcome.tsx`), so a Run ends the same way on a phone as in a
 * browser.
 */

/** What to tell a Person about a Run's ending, and whether asking again can help. */
export interface Ending {
  readonly words: string
  readonly again: boolean
}

/**
 * One sentence each, in the order: what happened, what to do. A model that cannot be reached is
 * not something asking again fixes, so that one offers nothing to press. A new way for a Run to
 * fail does not compile until it has words here.
 */
const FAILED = {
  Delivery: { words: 'Vivid could not start on that. Send it again.', again: true },
  RateLimited: { words: 'Vivid’s model is busy. Give it a moment, then try again.', again: true },
  ModelUnavailable: {
    words: 'Vivid’s model can’t be reached. Ask whoever runs this Vivid to check it.',
    again: false,
  },
  NoAnswer: { words: 'Vivid’s reply was empty.', again: true },
  TimedOut: { words: 'Vivid took too long and stopped.', again: true },
  Unexplained: { words: 'Vivid couldn’t finish that.', again: true },
} as const satisfies Record<RunFailure, Ending>

const LOST: Ending = {
  words: 'Vivid lost track of this one, so it may not have finished.',
  again: true,
}

/**
 * A Run sent something to a service and never heard back. Asking again could do it twice, so
 * there is nothing to press: the server holds the same action until its result is known.
 */
const UNHEARD: Ending = {
  words: 'Vivid didn’t hear back, so the result of that action isn’t known yet.',
  again: false,
}

/** The newest Run in a Thread, which is the one whose ending the Person is waiting on. */
export const newestRun = (runs: ReadonlyArray<Run>): Option.Option<Run> =>
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
export const endingOf = (run: Run): Option.Option<Ending> =>
  unheard(run) ? Option.some(UNHEARD) : executionEnding(run.state)

/** How execution ended, which says nothing when it ended with an answer or was stopped. */
const executionEnding = (state: RunState): Option.Option<Ending> =>
  RunState.match(state, {
    Working: () => Option.none(),
    Completed: () => Option.none(),
    Stopped: () => Option.none(),
    Failed: ({ reason }) => Option.some(FAILED[reason]),
    Unknown: () => Option.some(LOST),
  })
