import { BackgroundWork } from '@vivid/contracts'
import { clock, work } from '@vivid/state'
import { Activity, CircleStop, Trash2 } from 'lucide-react-native'
import { useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { warn } from '../../data/haptics'
import { useLive, useLiveData, type LiveData } from '../../data/live'
import { when } from '../../data/when'
import {
  dismissStopAll,
  stopEverything,
  stopWork,
  useStopAll,
  useWorkStandings,
} from '../../data/work'
import { Row, Section } from '../../ui/List'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import {
  Button,
  confirmDestructive,
  Empty,
  IconButton,
  Label,
  Notice,
  Skeleton,
  TARGET,
  type Tone,
} from '../../ui/ui'

const words = work.makeWorkWords(when)

/** The ink a standing reads in: quiet while going, amber when stuck, danger when broken. */
const TONE = {
  going: 'ink-2',
  stalled: 'status-approve',
  failing: 'status-danger',
} satisfies Record<work.Tone, Tone>

/** The kinds of work, each its own group, in the order a Person most needs them. */
const GROUPS = [
  {
    title: 'Working now',
    detail: 'Replies Vivid is still working on.',
    takes: BackgroundWork.guards.Run,
  },
  {
    title: 'Helpers',
    detail: 'Narrower work Vivid handed off while answering.',
    takes: BackgroundWork.guards.Helper,
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
 * What Vivid is doing for the Person in the background, as a sheet over Settings: the same live
 * list, words and Stop machines as the web's (`apps/web/src/screen/settings/Work.tsx`). What
 * differs is the phone's: Stop everything and Remove ask through the system alert, which is the
 * second press the web draws as a button, and a row's Stop is its icon at the trailing edge.
 */
export function Work({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const listed = useLive(data.live.work)
  return (
    <Sheet
      title="What Vivid is doing"
      detail="What runs while you are away, and a way to stop it."
      onClose={onClose}
    >
      <Live state={listed} loading={<Skeleton rows={4} />}>
        {(value) => <Pieces data={data} pieces={value.work} />}
      </Live>
    </Sheet>
  )
}

function Pieces({ data, pieces }: { data: LiveData; pieces: ReadonlyArray<BackgroundWork> }) {
  const standings = useWorkStandings()
  const all = useStopAll()
  // The page's one second clock: counts beside work move together, and only while shown.
  const now = useSyncExternalStore(clock.watch, clock.read, clock.read)
  const lineOf = (piece: BackgroundWork) => words(piece, now)
  const standingOf = (piece: BackgroundWork) =>
    standings.get(lineOf(piece).key) ?? work.RowStanding.cases.Shown.make({})
  const shown = pieces.filter((piece) => work.isDrawn(standingOf(piece)))
  const warnings = [...standings.values()].filter(work.RowStanding.guards.Warned)
  return (
    <>
      <StopEverything data={data} count={work.stoppable(shown).length} all={all} lineOf={lineOf} />
      {warnings.map(({ work: piece, reason }) => (
        <Notice
          key={lineOf(piece).key}
          message={work.notStoppedWords(lineOf(piece).title, reason)}
        />
      ))}
      {shown.length === 0 && (
        <Empty
          icon={Activity}
          title="Nothing in the background"
          line="When Vivid keeps working after you leave, watches for something, or makes an Integration for itself, it shows here with a way to stop it."
          room="page"
        />
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
                onStop={() => stop(data, piece, lineOf(piece))}
              />
            ))}
          </Section>
        )
      })}
    </>
  )
}

/** A Stop is one touch; a Remove cannot be undone, so it asks first, as Rules does. */
function stop(data: LiveData, piece: BackgroundWork, line: work.WorkLine) {
  if (line.stop === 'Stop') return stopWork(data, piece)
  confirmDestructive({
    title: `Remove ${line.title}?`,
    detail: 'Vivid made this Integration for itself. Removing it cannot be undone.',
    action: 'Remove',
    onConfirm: () => {
      warn()
      stopWork(data, piece)
    },
  })
}

/** One piece: its name, why it is there and where it stands, and its Stop at the trailing edge. */
function WorkRow({
  line,
  standing,
  onStop,
}: {
  line: work.WorkLine
  standing: work.RowStanding
  onStop: () => void
}) {
  const press = work.RowStanding.match(standing, {
    Shown: () => ({ busy: false, failed: false }),
    Stopping: () => ({ busy: true, failed: false }),
    Failed: () => ({ busy: false, failed: true }),
    // A folded or warned row is not drawn (`work.isDrawn`); these keep the match total.
    Folded: () => ({ busy: true, failed: false }),
    Warned: () => ({ busy: true, failed: false }),
  })
  const removes = line.stop === 'Remove'
  return (
    <View
      accessible={false}
      style={{
        minHeight: TARGET + 8,
        paddingLeft: 16,
        paddingRight: 6,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        {/* Two lines: a long title is how the Person tells one reply from another. */}
        <Label numberOfLines={2}>{line.title}</Label>
        <Label size="label" tone="ink-2">
          {line.detail}
          {' · '}
          <Label size="label" tone={TONE[line.tone]}>
            {line.standing}
          </Label>
        </Label>
        {press.failed && (
          <Label size="label" tone="status-danger" accessibilityRole="alert">
            That did not get through. Try again.
          </Label>
        )}
      </View>
      <IconButton
        icon={removes ? Trash2 : CircleStop}
        label={`${removes ? 'Remove' : 'Stop'} ${line.title}`}
        tone={removes ? 'status-danger' : 'ink-2'}
        disabled={press.busy}
        onPress={onStop}
      />
    </View>
  )
}

/**
 * Stop everything, at the top of the sheet. The system alert is its second press; the report that
 * comes back stays until the Person puts it away, because it is the one place that says what
 * could not be stopped.
 */
function StopEverything({
  data,
  count,
  all,
  lineOf,
}: {
  data: LiveData
  count: number
  all: work.AllStanding
  lineOf: (piece: BackgroundWork) => work.WorkLine
}) {
  const ask = () =>
    confirmDestructive({
      title: count === 1 ? 'Stop 1 thing?' : `Stop ${count} things?`,
      detail: 'Every reply, helper and watch Vivid has going stops. Nothing is deleted.',
      action: 'Stop everything',
      onConfirm: () => {
        warn()
        stopEverything(data)
      },
    })
  return work.AllStanding.match(all, {
    Idle: () =>
      count === 0 ? null : <Button label="Stop everything" kind="danger" morph onPress={ask} />,
    // The phone never rests in Armed: the alert's yes arms and confirms in one go.
    Armed: () => <Button label="Stop everything" kind="danger" morph onPress={ask} />,
    Stopping: () => (
      <Button label="Stopping everything…" kind="danger" morph disabled onPress={ask} />
    ),
    Unsent: () => (
      <>
        <Notice message="Stop everything did not get through. Some things may still be running." />
        <Button label="Try again" kind="danger" morph onPress={() => stopEverything(data)} />
      </>
    ),
    Reported: ({ report }) => (
      <>
        <Section
          title={report.length === 0 ? 'There was nothing to stop' : 'What Stop everything did'}
        >
          {report.length === 0 ? (
            <Row title="Everything had already finished." wrap />
          ) : (
            report.map((entry) => {
              const said = work.reportLine(entry, lineOf)
              return (
                <Row
                  key={lineOf(entry.work).key}
                  title={said.title}
                  detail={said.said}
                  danger={said.failed}
                />
              )
            })
          )}
        </Section>
        <Button label="Done" kind="ghost" onPress={() => dismissStopAll(data)} />
      </>
    ),
  })
}
