import {
  RunOutcome,
  RunState,
  RunUncertainty,
  type ActionOperationId,
  type Run,
  type RunFailure,
} from '@vivid/contracts'
import { checking } from '@vivid/state'
import { Option } from 'effect'
import type { ReactNode } from 'react'
import { checkAction, useChecking } from '../../data/checking'

/**
 * What to tell a Person about a Run that did not end with an answer, and whether asking again can
 * help. One sentence each, in the order: what happened, what to do. A model that cannot be reached
 * is not something asking again fixes, so that one offers nothing to press.
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
} satisfies Record<RunFailure, { words: string; again: boolean }>

const LOST = {
  words: 'Vivid lost track of this one, so it may not have finished.',
  again: true,
}

/** The newest Run in a Thread, which is the one whose ending the Person is waiting on. */
export const newestRun = (runs: ReadonlyArray<Run>) =>
  runs.reduce<Option.Option<Run>>(
    (newest, run) =>
      Option.isSome(newest) && newest.value.startedAt >= run.startedAt ? newest : Option.some(run),
    Option.none(),
  )

/** The operation of a Run whose outcome is an outward action whose result is not known. */
const unheardOf = (run: Run): Option.Option<ActionOperationId> =>
  run.outcome !== null &&
  RunOutcome.guards.Unknown(run.outcome) &&
  RunUncertainty.guards.Action(run.outcome.uncertainty)
    ? Option.some(run.outcome.uncertainty.operationId)
    : Option.none()

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
  const unheard = unheardOf(run)
  if (Option.isSome(unheard)) return <Unheard operationId={unheard.value} onAgain={onAgain} />
  const saying = endingOf(run.state)
  if (Option.isNone(saying)) return null
  return (
    <Line words={saying.value.words}>
      {saying.value.again && Option.isSome(onAgain) && (
        <Press onPress={onAgain.value}>Try again</Press>
      )}
    </Line>
  )
}

/**
 * A Run sent something to a service and never heard back. Asking again could do it twice, so
 * the server holds the same action until its result is known; `Check` asks the service whether
 * it happened (`@vivid/state` `checking`). Only once it is known not to have happened is
 * `Try again` offered.
 */
function Unheard({
  operationId,
  onAgain,
}: {
  operationId: ActionOperationId
  onAgain: Option.Option<() => void>
}) {
  const line = checking.lineOf(useChecking(), operationId)
  const check = () => checkAction(operationId)
  return (
    <Line words={checking.wordsOf(line)}>
      {checking.Line.match(line, {
        Unheard: () => <Press onPress={check}>Check</Press>,
        Checking: () => <Press disabled>Check</Press>,
        Applied: () => null,
        NotApplied: () =>
          Option.match(onAgain, {
            onNone: () => null,
            onSome: (again) => <Press onPress={again}>Try again</Press>,
          }),
        Unsure: () => <Press onPress={check}>Check</Press>,
      })}
    </Line>
  )
}

/** One line under the conversation: what happened, then what can be pressed. */
function Line({ words, children }: { words: string; children: ReactNode }) {
  return (
    <li className="flex animate-fade-in items-baseline gap-3 pl-9 text-label text-ink-3">
      <span className="min-w-0">{words}</span>
      {children}
    </li>
  )
}

/** A quiet text link beside the line, held (not hidden) while what it asks is on its way. */
function Press({
  onPress,
  disabled = false,
  children,
}: {
  onPress?: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className="shrink-0 cursor-pointer rounded-xs text-ink-2 underline decoration-line-4 underline-offset-4 transition-colors duration-(--dur-fast) hover:text-ink hover:decoration-ink-3 focus-visible:text-ink disabled:cursor-default disabled:text-ink-3 hover:disabled:text-ink-3 hover:disabled:decoration-line-4"
    >
      {children}
    </button>
  )
}
