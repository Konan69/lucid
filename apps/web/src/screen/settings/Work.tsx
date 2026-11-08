import { BackgroundWork } from '@vivid/contracts'
import { makeWhen, thisReader, work } from '@vivid/state'
import { CircleAlert, TriangleAlert } from 'lucide-react'
import { live, LiveState, useLive } from '../../data/live'
import { stopAll, stopWork, useStopAll, useWorkStandings } from '../../data/work'
import { Button } from '../../ui/button'
import { useNow } from '../../ui/clock'
import { cn } from '../../ui/cn'
import { Awaiting, Empty, Row, Section } from './Parts'

const words = work.makeWorkWords(makeWhen(thisReader()))

/**
 * The colour a standing reads in: quiet while going, amber when stuck, danger when broken. Amber is
 * the `approve` token because it is the one amber held to 4.5:1 on a light screen; `attention` is
 * the accent and would read as a link.
 */
const TONE = {
  going: 'text-ink-3',
  stalled: 'text-approve',
  failing: 'text-danger',
} satisfies Record<work.Tone, string>

/** The kinds of work, each its own group, in the order a Person most needs them. */
const GROUPS = [
  {
    title: 'Working now',
    detail: 'Replies Vivid is still working on.',
    takes: BackgroundWork.guards.Run,
  },
  {
    title: 'Watching',
    detail: 'Each one wakes Vivid when something happens in an Integration.',
    takes: BackgroundWork.guards.Watch,
  },
  {
    title: 'Made by Vivid',
    detail: 'Integrations Vivid wrote for itself. Removing one cannot be undone.',
    takes: BackgroundWork.guards.MadeIntegration,
  },
] as const

/**
 * What Vivid is doing for the Person in the background, each piece with where it stands and a way
 * to stop it, and one press that stops everything (Grok Bot's stop-all). The list is the server's
 * and live; a Stop is a machine per piece (`data/work.ts`), so a stopped row folds at once and
 * leaves when the server's next answer no longer lists it.
 */
export function Work() {
  const listed = useLive(live.work)
  const standings = useWorkStandings()
  const all = useStopAll()
  const now = useNow()
  if (!LiveState.$is('Ready')(listed)) return <Awaiting state={listed} />
  const pieces = listed.value.work
  const lineOf = (piece: BackgroundWork) => words(piece, now)
  const standingOf = (piece: BackgroundWork) =>
    standings.get(lineOf(piece).key) ?? work.RowStanding.cases.Shown.make({})
  const shown = pieces.filter((piece) => work.isDrawn(standingOf(piece)))
  const warnings = [...standings.values()].filter(work.RowStanding.guards.Warned)
  return (
    <>
      <StopEverything count={work.stoppable(shown).length} all={all} lineOf={lineOf} />
      {warnings.map(({ work: piece, reason }) => (
        <p
          key={lineOf(piece).key}
          role="status"
          className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger"
        >
          {work.notStoppedWords(lineOf(piece).title, reason)}
        </p>
      ))}
      {shown.length === 0 && (
        <Section title="Nothing in the background">
          <Empty>
            When Vivid keeps working after you leave, watches for something, or makes an Integration
            for itself, it shows here with a way to stop it.
          </Empty>
        </Section>
      )}
      {GROUPS.map((group) => {
        const members = shown.filter(group.takes)
        if (members.length === 0) return null
        return (
          <Section key={group.title} title={group.title} detail={group.detail}>
            {members.map((piece) => (
              <WorkRow
                key={lineOf(piece).key}
                line={lineOf(piece)}
                standing={standingOf(piece)}
                onStop={() => stopWork(piece)}
              />
            ))}
          </Section>
        )
      })}
    </>
  )
}

/** One piece: its name, why it is there and where it stands, and the press that ends it. */
function WorkRow({
  line,
  standing,
  onStop,
}: {
  line: work.WorkLine
  standing: work.RowStanding
  onStop: () => void
}) {
  const Icon = line.tone === 'failing' ? CircleAlert : TriangleAlert
  const label = line.stop === 'Remove' ? 'Remove' : 'Stop'
  const press = work.RowStanding.match(standing, {
    Shown: () => ({ text: label, busy: false, failed: false }),
    Stopping: () => ({
      text: line.stop === 'Remove' ? 'Removing…' : 'Stopping…',
      busy: true,
      failed: false,
    }),
    Failed: () => ({ text: label, busy: false, failed: true }),
    // A folded or warned row is not drawn (`work.isDrawn`); these keep the match total.
    Folded: () => ({ text: label, busy: true, failed: false }),
    Warned: () => ({ text: label, busy: true, failed: false }),
  })
  return (
    <Row
      // The label truncates on one line, so the whole title is there on hover.
      label={<span title={line.title}>{line.title}</span>}
      detail={
        <>
          <span className="wrap-anywhere">{line.detail}</span>
          <span aria-hidden> · </span>
          <span className={cn('inline-flex items-start gap-1 wrap-anywhere', TONE[line.tone])}>
            {line.tone !== 'going' && <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
            {line.standing}
          </span>
          {press.failed && (
            <span role="alert" className="block text-danger">
              That did not get through. Try again.
            </span>
          )}
        </>
      }
    >
      <Button
        size="sm"
        variant={line.stop === 'Remove' ? 'destructive' : 'outline'}
        disabled={press.busy}
        onClick={onStop}
      >
        {press.text}
      </Button>
    </Row>
  )
}

/**
 * Stop everything, at the top of the page. The first press says how much will stop and asks for a
 * second; the report that comes back stays until dismissed, line by line, because it is the one
 * place that says what could not be stopped.
 */
function StopEverything({
  count,
  all,
  lineOf,
}: {
  count: number
  all: work.AllStanding
  lineOf: (piece: BackgroundWork) => work.WorkLine
}) {
  const sentence = (
    // Narrow, the sentence takes its own line and the buttons sit under it at the trailing edge.
    <p className="w-full min-w-0 text-label text-ink-3 sm:w-auto sm:flex-1">
      Stops every reply Vivid is working on and every watch. Nothing is deleted.
    </p>
  )
  return work.AllStanding.match(all, {
    Idle: () =>
      count === 0 ? null : (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2 px-1">
          {sentence}
          <Button size="sm" variant="destructive" onClick={stopAll.arm}>
            Stop everything
          </Button>
        </div>
      ),
    Armed: () => (
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2 px-1">
        {sentence}
        <Button size="sm" variant="ghost" onClick={stopAll.disarm}>
          Cancel
        </Button>
        <Button size="sm" variant="destructive" onClick={stopAll.confirm} disabled={count === 0}>
          {work.stopAllLabel(count)}
        </Button>
      </div>
    ),
    Stopping: () => (
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2 px-1">
        {sentence}
        <Button size="sm" variant="destructive" disabled>
          Stopping everything…
        </Button>
      </div>
    ),
    Unsent: () => (
      <div
        role="alert"
        className="mb-4 flex items-center gap-3 rounded-control bg-danger-soft px-3 py-2"
      >
        <p className="min-w-0 flex-1 text-label text-danger">
          Stop everything did not get through. Some things may still be running.
        </p>
        <Button size="sm" variant="ghost" onClick={stopAll.dismiss}>
          Dismiss
        </Button>
        <Button size="sm" variant="destructive" onClick={stopAll.confirm}>
          Try again
        </Button>
      </div>
    ),
    Reported: ({ report }) => (
      <Section
        title={report.length === 0 ? 'There was nothing to stop' : 'What Stop everything did'}
        action={
          <Button size="sm" variant="ghost" onClick={stopAll.dismiss}>
            Done
          </Button>
        }
      >
        {report.length === 0 && <Empty>Everything had already finished.</Empty>}
        {report.map((entry) => {
          const said = work.reportLine(entry, lineOf)
          return (
            <Row
              key={lineOf(entry.work).key}
              label={said.title}
              detail={<span className={said.failed ? 'text-danger' : undefined}>{said.said}</span>}
            />
          )
        })}
      </Section>
    ),
  })
}
