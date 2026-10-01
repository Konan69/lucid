import {
  RoutineTrigger,
  type Occurrence,
  type Routine,
  type RoutineId,
  type RoutineWebhook,
  type ThreadId,
} from '@vivid/contracts'
import { Data, Option, Redacted, Result } from 'effect'
import { useState } from 'react'
import { ScrollView, Share as SystemShare, View } from 'react-native'
import { Clock3, Pause, Play, Plus, Webhook, type LucideIcon } from 'lucide-react-native'
import * as routines from '../../../web/src/data/routines'
import { commit, warn } from '../data/haptics'
import { LiveState, refusalOf, useLive, useLiveData, useLiveValue } from '../data/live'
import { useTheme } from '../theme'
import { Header, Screen } from '../ui/Header'
import { Row, Section } from '../ui/List'
import { Live } from '../ui/Live'
import { Sheet } from '../ui/Sheet'
import {
  Button,
  Chips,
  confirmDestructive,
  Dot,
  Empty,
  Field,
  IconButton,
  Label,
  Labelled,
  Notice,
  radius,
  Segmented,
  Skeleton,
  styles,
} from '../ui/ui'
import { useGo } from '../workspace'

/**
 * What is open over the list: nothing, the form for a new Routine, or one Routine. Only this is
 * local; the Routines themselves are read from the live query every render.
 */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Creating: {}
  Showing: { readonly id: RoutineId }
}>
const Over = Data.taggedEnum<Over>()

const formatTime = (value: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)

/**
 * The time zone a new schedule starts in: the one in the Person's Settings once that has
 * answered, and this phone's until then. It is derived on every render, so a form opened before
 * Settings arrived picks the right zone up without anything copying it into state.
 */
function useZone(): string {
  const data = useLiveData()
  const settings = useLive(data.live.settings)
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone
  return LiveState.$is('Ready')(settings) ? settings.value.timezone : device
}

/**
 * Routines: what Vivid does again and again, on a schedule or when something calls it. A Routine
 * belongs to the Person who set it up, runs as them, and reports in a Thread.
 */
export function Routines() {
  const data = useLiveData()
  const go = useGo()
  const list = useLive(data.live.routines)
  const [over, setOver] = useState<Over>(Over.Nothing())
  const close = () => setOver(Over.Nothing())
  const create = () => setOver(Over.Creating())
  // A Routine open here can be deleted from somewhere else; its sheet then simply is not drawn.
  const selected =
    Over.$is('Showing')(over) && LiveState.$is('Ready')(list)
      ? Option.fromUndefinedOr(list.value.routines.find((routine) => routine.id === over.id))
      : Option.none<Routine>()

  return (
    <Screen>
      <Header
        title="Routines"
        subtitle="What Vivid repeats, so you don’t have to."
        onBack={go.goBack}
        trailing={<IconButton icon={Plus} label="New routine" onPress={create} />}
      />
      <ScrollView contentContainerStyle={[styles.page, styles.column]}>
        <Live state={list} loading={<Skeleton rows={4} />}>
          {(value) =>
            value.routines.length === 0 ? (
              <Empty
                title="No routines yet"
                detail="Write an instruction once and Vivid follows it on a schedule, or each time something calls it."
              >
                <Button icon={Plus} label="New routine" onPress={create} />
              </Empty>
            ) : (
              <Section title="Yours">
                {value.routines.map((routine) => (
                  <RoutineRow
                    key={routine.id}
                    routine={routine}
                    onOpen={() => setOver(Over.Showing({ id: routine.id }))}
                  />
                ))}
              </Section>
            )
          }
        </Live>
      </ScrollView>
      {Over.$is('Creating')(over) && <Create onClose={close} />}
      {Option.isSome(selected) && (
        <Detail
          key={selected.value.id}
          routine={selected.value}
          onClose={close}
          onOpenThread={(id) => {
            close()
            go.navigate('Chat', { id })
          }}
        />
      )}
    </Screen>
  )
}

const latestStatus = (routine: Routine): Option.Option<Occurrence['status']> =>
  Option.map(routines.latestOccurrence(routine), (occurrence) => occurrence.status)

/** Whether the last thing that happened to a Routine is something its owner should look at. */
const troubled = (routine: Routine): boolean =>
  Option.contains(latestStatus(routine), 'failed') || routine.lastMissedAt !== null

/** The line under a Routine's name: what went wrong last, else that it is paused, else when it runs. */
function summaryOf(routine: Routine): string {
  if (Option.contains(latestStatus(routine), 'running')) return 'Running now'
  if (Option.contains(latestStatus(routine), 'failed')) return 'Last run failed'
  if (routine.lastMissedAt !== null) return `Missed ${formatTime(routine.lastMissedAt)}`
  if (!routine.enabled) return 'Paused'
  return routines.describeTrigger(routine.trigger)
}

/** The mark for each way a Routine starts; a new kind of trigger fails to compile here. */
const TRIGGER_MARK = {
  Schedule: Clock3,
  Webhook,
} as const satisfies Record<RoutineTrigger['_tag'], LucideIcon>

/** The small tile a Routine's row leads with: paused, or how it starts. */
function Mark({ routine }: { routine: Routine }) {
  const { colors: c } = useTheme()
  const Icon = routine.enabled ? TRIGGER_MARK[routine.trigger._tag] : Pause
  return (
    <View
      style={{
        width: 34,
        height: 34,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.row,
        backgroundColor: routine.enabled ? c['accent-soft'] : c['wash-pressed'],
      }}
    >
      <Icon size={17} strokeWidth={1.7} color={routine.enabled ? c['accent-ink'] : c['ink-3']} />
    </View>
  )
}

/** The dot at the end of a row: working now, on, in trouble, or paused. Its words are the summary. */
function standingTone(routine: Routine) {
  if (Option.contains(latestStatus(routine), 'running')) return 'status-working'
  if (troubled(routine)) return 'status-danger'
  return routine.enabled ? 'status-success' : 'ink-4'
}

function RoutineRow({ routine, onOpen }: { routine: Routine; onOpen: () => void }) {
  return (
    <Row
      leading={<Mark routine={routine} />}
      title={routine.name}
      detail={summaryOf(routine)}
      trailing={<Dot tone={standingTone(routine)} />}
      onPress={onOpen}
    />
  )
}

// ── The editor ───────────────────────────────────────────────────────────────

const KINDS = [
  { value: 'Schedule', label: 'On a schedule' },
  { value: 'Webhook', label: 'When something calls it' },
] as const satisfies ReadonlyArray<{ value: routines.TriggerKind; label: string }>

/** The value the schedule chips use for a cron expression that is none of the named ones. */
const OWN = 'own'

/** Name, instruction and what starts it: the same fields for a new Routine and an existing one. */
function Fieldset({
  fields,
  zone,
  onChange,
}: {
  fields: routines.RoutineFields
  zone: string
  onChange: (fields: routines.RoutineFields) => void
}) {
  const named = routines.SCHEDULE_PRESETS.some((preset) => preset.cron === fields.cron)
  return (
    <>
      <Labelled label="Name">
        <Field
          accessibilityLabel="Name"
          value={fields.name}
          maxLength={120}
          placeholder="Daily project brief"
          onChangeText={(name) => onChange({ ...fields, name })}
        />
      </Labelled>
      <Labelled label="Instruction">
        <Field
          accessibilityLabel="Instruction"
          value={fields.prompt}
          maxLength={4000}
          multiline
          placeholder="Review what moved in the project and write a short brief."
          onChangeText={(prompt) => onChange({ ...fields, prompt })}
          style={{ minHeight: 120, textAlignVertical: 'top' }}
        />
      </Labelled>
      <Labelled label="Starts">
        <Segmented
          label="What starts this routine"
          value={fields.kind}
          options={KINDS}
          onChange={(kind) => onChange({ ...fields, kind })}
        />
      </Labelled>
      {fields.kind === 'Webhook' ? (
        <Label size="label" tone="ink-3">
          Vivid starts this routine each time an outside service calls its address with its key, and
          reads whatever the service sends. You get the address and the key once the routine is
          saved.
        </Label>
      ) : (
        <>
          <Labelled label="When">
            <Chips
              label="When it runs"
              value={named ? fields.cron : OWN}
              options={[
                ...routines.SCHEDULE_PRESETS.map((preset) => ({
                  value: preset.cron,
                  label: preset.label,
                })),
                { value: OWN, label: 'Its own schedule' },
              ]}
              // Choosing "its own" drops the named schedule; the field below is where one is written.
              onChange={(cron) => onChange({ ...fields, cron: cron === OWN ? '' : cron })}
            />
          </Labelled>
          {!named && (
            <Labelled label="Cron expression">
              <Field
                accessibilityLabel="Cron expression"
                value={fields.cron}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="0 9 * * 1-5"
                onChangeText={(cron) => onChange({ ...fields, cron })}
              />
            </Labelled>
          )}
          <Labelled label="Time zone">
            <Field
              accessibilityLabel="Time zone"
              value={Option.getOrElse(fields.timezone, () => zone)}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(timezone) => onChange({ ...fields, timezone: Option.some(timezone) })}
            />
          </Labelled>
        </>
      )}
    </>
  )
}

/** The form for a new Routine. It waits for the server, which is what gives a Routine its id. */
function Create({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const zone = useZone()
  const [fields, setFields] = useState(routines.emptyFields)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  async function create() {
    setSaving(true)
    const result = await data.change((client) =>
      client.CreateRoutine({
        name: fields.name.trim(),
        prompt: fields.prompt.trim(),
        trigger: routines.triggerOf(fields, zone),
      }),
    )
    setSaving(false)
    if (Result.isFailure(result)) {
      setRefused(Option.some(result.failure.message))
      return
    }
    commit()
    // The call's answer can arrive before the live query's next result. Showing the Routine the
    // server just returned, as a change that is already accepted, keeps the list from lagging.
    data.live.routines.expect(routines.confirmed(result.success.routine))(true)
    onClose()
  }

  return (
    <Sheet title="New routine" onClose={onClose}>
      <Fieldset fields={fields} zone={zone} onChange={setFields} />
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Button
        kind="primary"
        label={saving ? 'Creating…' : 'Create routine'}
        disabled={saving || !routines.fieldsComplete(fields, zone)}
        onPress={() => void create()}
      />
    </Sheet>
  )
}

// ── One Routine ──────────────────────────────────────────────────────────────

/** One Routine: pause, run, its address if it has one, its fields and its history. */
function Detail({
  routine,
  onClose,
  onOpenThread,
}: {
  routine: Routine
  onClose: () => void
  onOpenThread: (id: ThreadId) => void
}) {
  const data = useLiveData()
  const zone = useZone()
  const [fields, setFields] = useState(() => routines.fieldsOf(routine))
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const savable =
    routines.fieldsComplete(fields, zone) && routines.fieldsDiffer(routine, fields, zone)

  /** The sheet shows the saved Routine at once; a refused save puts it back and says why. */
  async function save() {
    const changes = {
      name: fields.name.trim(),
      prompt: fields.prompt.trim(),
      trigger: routines.triggerOf(fields, zone),
    }
    const result = await data.change(
      (client) => client.PatchRoutine({ id: routine.id, patch: changes }),
      () => data.live.routines.expect(routines.edited(routine.id, changes)),
    )
    setRefused(refusalOf(result))
  }

  return (
    <Sheet title={routine.name} detail={summaryOf(routine)} onClose={onClose}>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Controls routine={routine} onClose={onClose} onRefused={setRefused} />
      {routine.lastMissedAt !== null && (
        <Notice
          message={`Vivid could not run this at ${formatTime(routine.lastMissedAt)}. It was not run later on its own. Run it now if you still want it.`}
        />
      )}
      <Fieldset fields={fields} zone={zone} onChange={setFields} />
      <Button kind="primary" label="Save changes" disabled={!savable} onPress={() => void save()} />
      <History routine={routine} onOpenThread={onOpenThread} />
    </Sheet>
  )
}

/** Pause or resume, run now, get a webhook Routine's address, delete. */
function Controls({
  routine,
  onClose,
  onRefused,
}: {
  routine: Routine
  onClose: () => void
  onRefused: (message: Option.Option<string>) => void
}) {
  const data = useLiveData()
  // Starting an Occurrence has no result to predict (its id is the server's), so the button says
  // it was pressed until the call returns; the live query then shows the Occurrence itself.
  const [starting, setStarting] = useState(false)
  const running = starting || Option.contains(latestStatus(routine), 'running')

  async function toggle() {
    commit()
    const enabled = !routine.enabled
    const result = await data.change(
      (client) => client.PatchRoutine({ id: routine.id, patch: { enabled } }),
      () => data.live.routines.expect(routines.enabledSet(routine.id, enabled)),
    )
    onRefused(refusalOf(result))
  }

  async function run() {
    commit()
    setStarting(true)
    const result = await data.change((client) => client.RunRoutine({ id: routine.id }))
    setStarting(false)
    onRefused(refusalOf(result))
  }

  /** Leaves the sheet at once; if the server refuses, the Routine is back in the list. */
  const remove = () =>
    confirmDestructive({
      title: `Delete “${routine.name}”?`,
      detail: 'Its history goes with it. This cannot be undone.',
      action: 'Delete routine',
      onConfirm: () => {
        warn()
        onClose()
        void data.change(
          (client) => client.DeleteRoutine({ id: routine.id }),
          () => data.live.routines.expect(routines.removed(routine.id)),
        )
      },
    })

  return (
    <View style={{ gap: 10 }}>
      <View style={styles.wrap}>
        <Button
          kind="primary"
          icon={Play}
          label={running ? 'Running…' : 'Run now'}
          disabled={running}
          onPress={() => void run()}
        />
        <Button
          icon={routine.enabled ? Pause : Play}
          label={routine.enabled ? 'Pause' : 'Resume'}
          onPress={() => void toggle()}
        />
        <Button kind="danger" label="Delete" onPress={remove} />
      </View>
      {RoutineTrigger.guards.Webhook(routine.trigger) && (
        <Address routine={routine} onRefused={onRefused} />
      )}
    </View>
  )
}

/**
 * Asks for a webhook Routine's address and key, and shows them once.
 *
 * The key stays wrapped in `Redacted` in this component's state and is unwrapped only where it
 * is drawn and handed to the share sheet. It is never written anywhere else: closing the sheet
 * drops the only copy the app has, and asking again makes the server issue a new key that ends
 * this one.
 */
function Address({
  routine,
  onRefused,
}: {
  routine: Routine
  onRefused: (message: Option.Option<string>) => void
}) {
  const data = useLiveData()
  const [asking, setAsking] = useState(false)
  const [issued, setIssued] = useState<Option.Option<RoutineWebhook>>(Option.none())

  async function ask() {
    setAsking(true)
    const result = await data.change((client) => client.IssueRoutineWebhook({ id: routine.id }))
    setAsking(false)
    onRefused(refusalOf(result))
    if (Result.isSuccess(result)) setIssued(Option.some(result.success))
  }

  return Option.match(issued, {
    onNone: () => (
      <View style={{ gap: 6 }}>
        <Button
          label={asking ? 'Asking…' : 'Get its address and key'}
          disabled={asking}
          onPress={() => void ask()}
          containerStyle={{ alignSelf: 'flex-start' }}
        />
        <Label size="caption" tone="ink-3">
          Each time you get the address, the key is replaced and the one before it stops working.
        </Label>
      </View>
    ),
    onSome: (webhook) => (
      <View style={{ gap: 10 }}>
        <Labelled label="Address">
          <Label selectable size="label" tone="ink-2">
            {webhook.address}
          </Label>
        </Labelled>
        <Labelled label="Key, shown only now">
          <Label selectable size="label" tone="ink-2">
            {Redacted.value(webhook.key)}
          </Label>
        </Labelled>
        <Label size="caption" tone="ink-3">
          Send a POST request to the address, with the key as a bearer token in the Authorization
          header.
        </Label>
        <Button
          label="Send them somewhere safe"
          onPress={() =>
            void SystemShare.share({
              message: `${webhook.address}\n${Redacted.value(webhook.key)}`,
            })
          }
          containerStyle={{ alignSelf: 'flex-start' }}
        />
      </View>
    ),
  })
}

// ── History ──────────────────────────────────────────────────────────────────

const OCCURRENCE = {
  running: { label: 'Running', tone: 'status-working' },
  succeeded: { label: 'Done', tone: 'status-success' },
  failed: { label: 'Failed', tone: 'status-danger' },
} as const satisfies Record<Occurrence['status'], { label: string; tone: string }>

/**
 * Every Occurrence of the Routine, newest first. Each ran in a Thread; a row opens that Thread
 * once it is in the Person's live list of Threads, and is plain text until then.
 */
function History({
  routine,
  onOpenThread,
}: {
  routine: Routine
  onOpenThread: (id: ThreadId) => void
}) {
  const data = useLiveData()
  const threads = useLiveValue(data.live.threads)
  const reachable = (id: ThreadId) =>
    Option.exists(threads, (list) => list.threads.some((thread) => thread.id === id))
  if (routine.runs.length === 0) {
    return (
      <Label size="label" tone="ink-3">
        It has not run yet.
      </Label>
    )
  }
  return (
    <Section title="History">
      {routine.runs.map((occurrence) => (
        <Row
          key={occurrence.id}
          leading={<Dot tone={OCCURRENCE[occurrence.status].tone} />}
          title={`${OCCURRENCE[occurrence.status].label} · ${formatTime(occurrence.startedAt)}`}
          detail={Option.getOrUndefined(
            Option.orElse(Option.fromNullOr(occurrence.error), () =>
              Option.fromNullOr(occurrence.output),
            ),
          )}
          onPress={
            reachable(occurrence.threadId) ? () => onOpenThread(occurrence.threadId) : undefined
          }
        />
      ))}
    </Section>
  )
}
