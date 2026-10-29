import { ChildRunDetail, ChildRunResult, type ChildRun } from '@vivid/contracts'
import { helpers, LiveState } from '@vivid/state'
import { Option } from 'effect'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { stopHelper, useHelperResult, useHelperStop } from '../../data/helpers'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Markdown } from '../../ui/Markdown'

/**
 * The helpers one step of Vivid's reply started, under that step: a quiet line naming them, then
 * one row each with what it was asked to do and where it stands. A row opens to the helper's
 * answer, or why it has none; while it works it has a Stop of its own. It is drawn in the reply's
 * own quiet voice (`AskedFirst`, `Cards.tsx`): no card, no box around the rows.
 */
export function Children({ runs }: { runs: ReadonlyArray<ChildRun> }) {
  const stop = useHelperStop()
  if (runs.length === 0) return null
  return (
    <div className="mt-3">
      <p className="text-meta font-meta text-ink-3">
        {runs.length === 1 ? 'A helper' : `${runs.length} helpers`} working on parts of this
      </p>
      <ul className="mt-1">
        {runs.map((run) => (
          <Helper key={run.id} run={run} stop={stop} />
        ))}
      </ul>
    </div>
  )
}

/** One helper's row: its brief and state, opening to its result, with Stop while it works. */
function Helper({ run, stop }: { run: ChildRun; stop: helpers.Reading }) {
  const [open, setOpen] = useState(false)
  const refusal = helpers.refusalFor(stop, run.id)
  return (
    <li data-helper={run.id}>
      <div className="group/row -mx-2 flex min-h-11 items-center gap-2 rounded-row px-2 py-1 transition-colors duration-(--dur-fast) hover:bg-wash-hover">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left outline-none focus-visible:underline"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-4 shrink-0 text-ink-4 transition-transform duration-(--dur-fast) group-hover/row:text-ink-3',
              open && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-title font-title text-ink">{run.brief}</span>
            <span className="block truncate text-label font-meta text-ink-3">
              {helpers.helperStatus(run)}
            </span>
          </span>
        </button>
        {helpers.stoppable(run) && (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Stop this helper"
            disabled={helpers.isWaiting(stop)}
            onClick={() => stopHelper(run.id)}
          >
            Stop
          </Button>
        )}
      </div>
      {Option.isSome(refusal) && (
        <p role="alert" className="ps-6.5 text-label text-danger">
          {refusal.value}
        </p>
      )}
      {open && <Opened run={run} />}
    </li>
  )
}

/** What an opened row shows: the answer once there is one, or how far it got. */
function Opened({ run }: { run: ChildRun }) {
  const reading = useHelperResult(run)
  return (
    <div dir="auto" className="ps-6.5 pt-1 pb-2 text-ink-2 wrap-anywhere">
      {LiveState.$match(reading, {
        Loading: () => <p className="text-label text-ink-3">Opening…</p>,
        Failed: () => (
          <p className="text-label text-ink-3">Its answer could not be opened just now.</p>
        ),
        Ready: ({ value }) =>
          ChildRunDetail.match(value, {
            Active: () => (
              <p className="text-label text-ink-3">Still working. Its answer comes here.</p>
            ),
            Ended: ({ result }) => <Answer result={result} />,
          }),
      })}
    </div>
  )
}

/** A finished helper's answer in its own words, or one line of why it has none. */
function Answer({ result }: { result: ChildRunResult }) {
  return ChildRunResult.match(result, {
    Completed: ({ text }) => <Markdown content={text} />,
    Failed: ({ failure }) => (
      <p className="text-label text-ink-3">
        {failure._tag === 'DeadlinePassed'
          ? 'It ran out of time before it had an answer.'
          : 'It could not finish.'}
      </p>
    ),
    Stopped: ({ by }) => (
      <p className="text-label text-ink-3">
        {by === 'Person' ? 'Stopped before it finished.' : 'Vivid stopped it before it finished.'}
      </p>
    ),
  })
}
