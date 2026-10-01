import { RoutineTrigger, type RoutineId, type RoutineWebhook, type Thread } from '@vivid/contracts'
import type { RuntimeConversation } from '@vivid/state'
import type { LiveStateOf } from '@vivid/state'
import { Data, Option, Redacted, Result } from 'effect'
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  Link2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Webhook,
} from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { change, live, LiveState, useLive, useLiveValue } from '../data/live'
import { routines as routinesData } from '@vivid/state'
import type { ProductFailure } from '../data/runtime'
import { Button, IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { Copy } from '../ui/Copy'
import { Dialog, DialogActions } from '../ui/Dialog'
import { Field, Input, Select, Textarea } from '../ui/Field'
import { Live } from '../ui/Live'
import { Notice } from '../ui/Notice'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import { BAR } from './bar'

type Routine = routinesData.Routine
type Occurrence = routinesData.Occurrence

/**
 * What the screen is showing: the list, the form for a new Routine, or one Routine. Only this is
 * local; the Routines themselves are read from the live query every render.
 */
type View = Data.TaggedEnum<{
  Overview: {}
  Creating: {}
  Detail: { readonly id: RoutineId }
}>
const View = Data.taggedEnum<View>()

/** The live query of Routines, in whichever of its three states it is. */
type RoutinesState = LiveStateOf<typeof live.routines>

/** What a change came to: nothing to say, or the server's sentence about why it refused. */
const refusal = <Value,>(result: Result.Result<Value, ProductFailure>): Option.Option<string> =>
  Result.isFailure(result) ? Option.some(result.failure.message) : Option.none()

const formatTime = (value: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)

/**
 * The time zone a new schedule starts in: the one in the Person's Settings once that has
 * answered, and the browser's until then. It is derived on every render, so a form opened before
 * Settings arrived picks the right zone up without anything copying it into state.
 */
function useZone(): string {
  const settings = useLive(live.settings)
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone
  return LiveState.$match(settings, {
    Loading: () => browser,
    Failed: () => browser,
    Ready: ({ value }) => value.timezone,
  })
}

/**
 * Routines: what Vivid does again and again, on a schedule or when something calls it.
 *
 * `onOpenConversation` opens the Thread an Occurrence ran in. It takes the Thread itself, so a
 * history row is a link only once that Thread is in the Person's live list of Threads.
 */
export function Routines({
  onOpenConversation,
}: {
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  const [view, setView] = useState<View>(View.Overview())
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const routines = useLive(live.routines)

  // A Routine open here can be deleted from somewhere else; its page then falls back to the list.
  const selected = View.$is('Detail')(view)
    ? LiveState.$match(routines, {
        Loading: () => Option.none<Routine>(),
        Failed: () => Option.none<Routine>(),
        Ready: ({ value }) => Option.fromUndefinedOr(value.routines.find((r) => r.id === view.id)),
      })
    : Option.none<Routine>()
  const shown = View.$is('Detail')(view) && Option.isNone(selected) ? View.Overview() : view
  const goTo = (next: View) => {
    setRefused(Option.none())
    setView(next)
  }
  const title = View.$match(shown, {
    Overview: () => 'Routines',
    Creating: () => 'New routine',
    Detail: () => Option.match(selected, { onNone: () => 'Routines', onSome: (r) => r.name }),
  })

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <header className={BAR}>
        {!View.$is('Overview')(shown) && (
          <IconButton label="Back to Routines" onClick={() => goTo(View.Overview())}>
            <ChevronRight className="size-4 rotate-180" />
          </IconButton>
        )}
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{title}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto flex w-full max-w-230 flex-col gap-3 px-5 pt-1 pb-10 sm:px-8">
          {Option.isSome(refused) && <Notice>{refused.value}</Notice>}
          <RoutinesBody
            view={shown}
            routines={routines}
            selected={selected}
            onView={goTo}
            onRefused={setRefused}
            onOpenConversation={onOpenConversation}
          />
        </div>
      </div>
    </section>
  )
}

/** Chooses the list, the new-Routine form or one Routine's page. */
function RoutinesBody({
  view,
  routines,
  selected,
  onView,
  onRefused,
  onOpenConversation,
}: {
  view: View
  routines: RoutinesState
  selected: Option.Option<Routine>
  onView: (view: View) => void
  onRefused: (message: Option.Option<string>) => void
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  return View.$match(view, {
    Overview: () => (
      <RoutinesOverview
        state={routines}
        onCreate={() => onView(View.Creating())}
        onSelect={(routine) => onView(View.Detail({ id: routine.id }))}
      />
    ),
    Creating: () => (
      <NewRoutine
        onCancel={() => onView(View.Overview())}
        onCreated={(routine) => onView(View.Detail({ id: routine.id }))}
        onRefused={onRefused}
      />
    ),
    Detail: () =>
      Option.match(selected, {
        onNone: () => null,
        onSome: (routine) => (
          <RoutineDetail
            key={routine.id}
            routine={routine}
            onBack={() => onView(View.Overview())}
            onRefused={onRefused}
            onOpenConversation={onOpenConversation}
          />
        ),
      }),
  })
}

// ── The list ─────────────────────────────────────────────────────────────────

/** The Person's Routines: a skeleton while loading, one sentence when there are none, else rows. */
function RoutinesOverview({
  state,
  onCreate,
  onSelect,
}: {
  state: RoutinesState
  onCreate: () => void
  onSelect: (routine: Routine) => void
}) {
  return (
    <div>
      <p className="px-0.5 text-label text-ink-3">What Vivid repeats, so you don&apos;t have to.</p>
      <div className="mt-4">
        <Live state={state} loading={<Skeleton of="row" count={3} />}>
          {({ routines }) =>
            routines.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-16 text-center">
                <Clock3 className="size-5 text-ink-4" />
                <p className="mt-3 text-title font-title text-ink">No routines yet</p>
                <p className="mt-1 mb-5 max-w-sm text-label text-pretty text-ink-3">
                  Write an instruction once and Vivid follows it on a schedule, or each time
                  something calls it.
                </p>
                <Button icon={<Plus className="size-3.5" />} onClick={onCreate}>
                  New routine
                </Button>
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-px">
                  {routines.map((routine) => (
                    <li key={routine.id}>
                      <RoutineRow routine={routine} onOpen={() => onSelect(routine)} />
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={onCreate}
                  className="mt-1 flex w-full cursor-pointer items-center gap-2.5 rounded-row p-2.5 text-left text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
                >
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2">
                    <Plus className="size-4" />
                  </span>
                  <span className="text-title">New routine</span>
                </button>
              </>
            )
          }
        </Live>
      </div>
    </div>
  )
}

/** What a Routine's row needs to know about its most recent Occurrence. */
const latestStatus = (routine: Routine): Option.Option<Occurrence['status']> =>
  Option.map(routinesData.latestOccurrence(routine), (occurrence) => occurrence.status)

/** The line under a Routine's name: what went wrong last, else when it runs, else that it is paused. */
function routineSummary(routine: Routine): string {
  if (Option.contains(latestStatus(routine), 'failed')) return 'Last run failed'
  if (routine.lastMissedAt !== null) return `Missed ${formatTime(routine.lastMissedAt)}`
  if (!routine.enabled) return 'Paused'
  return routinesData.describeTrigger(routine.trigger)
}

/** The mark for each way a Routine starts; a new kind of trigger fails to compile here. */
const TRIGGER_MARK = {
  Schedule: <Clock3 className="size-4" />,
  Webhook: <Webhook className="size-4" />,
} satisfies Record<RoutineTrigger['_tag'], ReactNode>

/** The mark a row leads with: paused, or how the Routine starts. */
function RoutineMark({ routine }: { routine: Routine }) {
  return routine.enabled ? TRIGGER_MARK[routine.trigger._tag] : <Pause className="size-4" />
}

/** One Routine in the list. The whole row opens it. */
function RoutineRow({ routine, onOpen }: { routine: Routine; onOpen: () => void }) {
  const troubled = Option.contains(latestStatus(routine), 'failed') || routine.lastMissedAt !== null
  const running = Option.contains(latestStatus(routine), 'running')
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-row p-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover"
    >
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
        <RoutineMark routine={routine} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title text-ink">{routine.name}</span>
        <span
          className={cn(
            'block truncate text-meta font-meta',
            troubled ? 'text-danger' : 'text-ink-3',
          )}
        >
          {running ? 'Running now' : routineSummary(routine)}
        </span>
      </span>
      {routine.enabled && routine.nextRunAt !== null && (
        <span className="hidden text-right text-meta font-meta text-ink-3 sm:block">
          Next
          <br />
          {formatTime(routine.nextRunAt)}
        </span>
      )}
      <i
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          running && 'animate-status-pulse bg-working',
          !running && (routine.enabled ? 'bg-success' : 'bg-ink-4'),
        )}
        aria-hidden
      />
    </button>
  )
}

// ── The editor ───────────────────────────────────────────────────────────────

const TRIGGER_LABEL = {
  Schedule: 'On a schedule',
  Webhook: 'When something calls it',
} satisfies Record<routinesData.TriggerKind, string>

/** Name, instruction and what starts it: the same fields for a new Routine and an existing one. */
function RoutineFieldset({
  fields,
  zone,
  focusName,
  onChange,
}: {
  fields: routinesData.RoutineFields
  zone: string
  focusName: boolean
  onChange: (fields: routinesData.RoutineFields) => void
}) {
  return (
    <>
      <Field label="Name">
        <Input
          autoFocus={focusName}
          required
          maxLength={120}
          value={fields.name}
          onChange={(event) => onChange({ ...fields, name: event.currentTarget.value })}
          placeholder="Daily Project brief"
        />
      </Field>
      <Field label="Instruction">
        <Textarea
          required
          maxLength={4000}
          rows={5}
          value={fields.prompt}
          onChange={(event) => onChange({ ...fields, prompt: event.currentTarget.value })}
          placeholder="Review what moved in the Project and write a short brief."
        />
      </Field>
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-label font-title text-ink-2">Starts</span>
        <Segmented
          label="What starts this Routine"
          value={fields.kind}
          options={routinesData.TRIGGER_KINDS.map((kind) => ({
            value: kind,
            name: TRIGGER_LABEL[kind],
            label: TRIGGER_LABEL[kind],
          }))}
          onChange={(kind) => onChange({ ...fields, kind })}
        />
      </div>
      {fields.kind === 'Schedule' ? (
        <ScheduleFields fields={fields} zone={zone} onChange={onChange} />
      ) : (
        <p className="rounded-card bg-surface-2 px-4 py-3 text-label text-ink-3 smooth-shadow-ring-xs">
          Vivid starts this Routine each time an outside service calls its address with its key, and
          reads whatever the service sends. You get the address and the key once the Routine is
          saved.
        </p>
      )}
    </>
  )
}

/** When a scheduled Routine runs: a named schedule or a cron expression, and the time zone. */
function ScheduleFields({
  fields,
  zone,
  onChange,
}: {
  fields: routinesData.RoutineFields
  zone: string
  onChange: (fields: routinesData.RoutineFields) => void
}) {
  const preset = routinesData.SCHEDULE_PRESETS.some((candidate) => candidate.cron === fields.cron)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="When">
          <Select
            value={fields.cron}
            onChange={(event) => onChange({ ...fields, cron: event.currentTarget.value })}
          >
            {routinesData.SCHEDULE_PRESETS.map((option) => (
              <option key={option.cron} value={option.cron}>
                {option.label}
              </option>
            ))}
            {/* A schedule written by hand has no name; it is listed so the select can show it. */}
            {!preset && <option value={fields.cron}>Its own schedule</option>}
          </Select>
        </Field>
        <Field label="Time zone">
          <Input
            required
            value={Option.getOrElse(fields.timezone, () => zone)}
            onChange={(event) =>
              onChange({ ...fields, timezone: Option.some(event.currentTarget.value) })
            }
          />
        </Field>
      </div>
      <Field label="Cron expression" hint="for a schedule not listed above">
        <Input
          required
          value={fields.cron}
          onChange={(event) => onChange({ ...fields, cron: event.currentTarget.value })}
        />
      </Field>
    </>
  )
}

/** The form for a new Routine. It waits for the server, which is what gives a Routine its id. */
function NewRoutine({
  onCancel,
  onCreated,
  onRefused,
}: {
  onCancel: () => void
  onCreated: (routine: Routine) => void
  onRefused: (message: Option.Option<string>) => void
}) {
  const zone = useZone()
  const [fields, setFields] = useState(routinesData.emptyFields)
  const [saving, setSaving] = useState(false)

  async function create(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    const result = await change((client) =>
      client.CreateRoutine({
        name: fields.name.trim(),
        prompt: fields.prompt.trim(),
        trigger: routinesData.triggerOf(fields, zone),
      }),
    )
    setSaving(false)
    onRefused(refusal(result))
    if (Result.isFailure(result)) return
    // The call's answer can arrive before the live query's next result. Showing the Routine the
    // server just returned, as a change that is already accepted, keeps its page from opening on
    // a list that does not have it yet.
    live.routines.expect(routinesData.confirmed(result.success.routine))(true)
    onCreated(result.success.routine)
  }

  return (
    <form onSubmit={(event) => void create(event)} className="space-y-4 pt-2">
      <RoutineFieldset fields={fields} zone={zone} focusName onChange={setFields} />
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !routinesData.fieldsComplete(fields, zone)}
        >
          {saving ? 'Creating' : 'Create routine'}
        </Button>
      </div>
    </form>
  )
}

// ── One Routine ──────────────────────────────────────────────────────────────

/** One Routine's page: pause, run, its address if it has one, its fields and its history. */
function RoutineDetail({
  routine,
  onBack,
  onRefused,
  onOpenConversation,
}: {
  routine: Routine
  onBack: () => void
  onRefused: (message: Option.Option<string>) => void
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  const zone = useZone()
  const [fields, setFields] = useState(() => routinesData.fieldsOf(routine))
  const savable =
    routinesData.fieldsComplete(fields, zone) && routinesData.fieldsDiffer(routine, fields, zone)

  /** The page shows the saved Routine at once; a refused save puts it back and says why. */
  async function save(event: FormEvent) {
    event.preventDefault()
    const changes = {
      name: fields.name.trim(),
      prompt: fields.prompt.trim(),
      trigger: routinesData.triggerOf(fields, zone),
    }
    const result = await change(
      (client) => client.PatchRoutine({ id: routine.id, patch: changes }),
      () => live.routines.expect(routinesData.edited(routine.id, changes)),
    )
    onRefused(refusal(result))
  }

  return (
    <div className="pt-2">
      <RoutineControls routine={routine} onBack={onBack} onRefused={onRefused} />
      {routine.lastMissedAt !== null && (
        <div className="mb-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-label text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            Vivid could not run this at {formatTime(routine.lastMissedAt)}. It was not run later on
            its own. Run it now if you still want it.
          </p>
        </div>
      )}
      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <RoutineFieldset fields={fields} zone={zone} focusName={false} onChange={setFields} />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" variant="primary" disabled={!savable}>
            Save changes
          </Button>
        </div>
      </form>
      <RoutineHistory routine={routine} onOpenConversation={onOpenConversation} />
    </div>
  )
}

/** Pause or resume, run now, get a webhook Routine's address, delete. */
function RoutineControls({
  routine,
  onBack,
  onRefused,
}: {
  routine: Routine
  onBack: () => void
  onRefused: (message: Option.Option<string>) => void
}) {
  // Starting an Occurrence has no result to predict (its id is the server's), so the button says
  // it was pressed until the call returns; the live query then shows the Occurrence itself.
  const [starting, setStarting] = useState(false)
  const latest = latestStatus(routine)
  const running = Option.contains(latest, 'running')
  const retry = Option.contains(latest, 'failed') || routine.lastMissedAt !== null

  async function toggle() {
    const enabled = !routine.enabled
    const result = await change(
      (client) => client.PatchRoutine({ id: routine.id, patch: { enabled } }),
      () => live.routines.expect(routinesData.enabledSet(routine.id, enabled)),
    )
    onRefused(refusal(result))
  }

  async function run() {
    setStarting(true)
    const result = await change((client) => client.RunRoutine({ id: routine.id }))
    setStarting(false)
    onRefused(refusal(result))
  }

  /** Leaves the page at once; if the server refuses, the Routine is back in the list. */
  async function remove() {
    if (!window.confirm(`Delete “${routine.name}”? Its history goes with it.`)) return
    onBack()
    const result = await change(
      (client) => client.DeleteRoutine({ id: routine.id }),
      () => live.routines.expect(routinesData.removed(routine.id)),
    )
    onRefused(refusal(result))
  }

  return (
    <div className="mb-5 border-b border-line-1 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          icon={routine.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          onClick={() => void toggle()}
        >
          {routine.enabled ? 'Pause' : 'Resume'}
        </Button>
        <Button
          variant="primary"
          disabled={starting || running}
          icon={retry ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}
          onClick={() => void run()}
        >
          {starting || running ? 'Running' : 'Run now'}
        </Button>
        {RoutineTrigger.guards.Webhook(routine.trigger) && (
          <WebhookAddress routine={routine} onRefused={onRefused} />
        )}
        <button
          type="button"
          onClick={() => void remove()}
          className="ml-auto inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control px-3 text-label text-danger transition-colors duration-(--dur-fast) hover:bg-danger-soft"
        >
          <Trash2 className="size-3.5" />
          Delete
        </button>
      </div>
      {RoutineTrigger.guards.Webhook(routine.trigger) && (
        <p className="mt-2 text-meta font-meta text-ink-3">
          Each time you get the address, the key is replaced and the one before it stops working.
        </p>
      )}
    </div>
  )
}

/**
 * Asks for a webhook Routine's address and key, and shows them once.
 *
 * The key stays wrapped in `Redacted` in this component's state and is unwrapped only where it is
 * drawn and copied. It is never written anywhere else: closing the dialog drops the only copy the
 * app has, and asking again makes the server issue a new key that ends this one.
 */
function WebhookAddress({
  routine,
  onRefused,
}: {
  routine: Routine
  onRefused: (message: Option.Option<string>) => void
}) {
  const [asking, setAsking] = useState(false)
  const [issued, setIssued] = useState<Option.Option<RoutineWebhook>>(Option.none())

  async function ask() {
    setAsking(true)
    const result = await change((client) => client.IssueRoutineWebhook({ id: routine.id }))
    setAsking(false)
    onRefused(refusal(result))
    if (Result.isSuccess(result)) setIssued(Option.some(result.success))
  }

  return (
    <>
      <Button disabled={asking} icon={<Link2 className="size-3.5" />} onClick={() => void ask()}>
        Get address
      </Button>
      {Option.isSome(issued) && (
        <Dialog
          title={`Address for ${routine.name}`}
          description="Send a POST request to the address, with the key as a bearer token in the Authorization header."
          width="md"
          onClose={() => setIssued(Option.none())}
        >
          <div className="flex flex-col gap-3">
            <Copyable label="Address" name="the address" read={() => issued.value.address} />
            <Copyable label="Key" name="the key" read={() => Redacted.value(issued.value.key)} />
            <p className="text-label text-ink-2">
              The key is shown only now. Copy it before you close this. Getting the address again
              replaces the key.
            </p>
          </div>
          <DialogActions>
            <Button variant="primary" onClick={() => setIssued(Option.none())}>
              Done
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  )
}

/** One value to copy out of the dialog: its label, the value itself, and a copy button. */
function Copyable({ label, name, read }: { label: string; name: string; read: () => string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label font-title text-ink-2">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-control bg-well px-3 py-2 font-mono text-meta break-all text-ink select-all">
          {read()}
        </code>
        <Copy name={name} read={read} />
      </div>
    </div>
  )
}

// ── History ──────────────────────────────────────────────────────────────────

const OCCURRENCE = {
  running: { label: 'Running', dot: 'animate-status-pulse bg-working' },
  succeeded: { label: 'Done', dot: 'bg-success' },
  failed: { label: 'Failed', dot: 'bg-danger' },
} satisfies Record<Occurrence['status'], { label: string; dot: string }>

/**
 * Every Occurrence of the Routine, newest first. Each ran in a Thread; a row opens that Thread
 * once it is in the Person's live list of Threads, and is plain text until then.
 */
function RoutineHistory({
  routine,
  onOpenConversation,
}: {
  routine: Routine
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  const threads = useLiveValue(live.threads)
  return (
    <div className="mt-7 border-t border-line-1 pt-4">
      <h2 className="text-label font-title text-ink-2">History</h2>
      {routine.runs.length === 0 ? (
        <p className="mt-2 text-label text-ink-3">It has not run yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {routine.runs.map((occurrence) => (
            <li key={occurrence.id}>
              <OccurrenceRow
                occurrence={occurrence}
                thread={Option.flatMap(threads, (list) =>
                  Option.fromUndefinedOr(list.threads.find((t) => t.id === occurrence.threadId)),
                )}
                onOpenConversation={onOpenConversation}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A history row: a link to the Occurrence's Thread when the Person has it, plain when not. */
function OccurrenceRow({
  occurrence,
  thread,
  onOpenConversation,
}: {
  occurrence: Occurrence
  thread: Option.Option<Thread>
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  if (Option.isNone(thread)) {
    return (
      <div className="rounded-row bg-surface-2 px-3 py-2.5 smooth-shadow-ring-xs">
        <OccurrenceSummary occurrence={occurrence} trailing={null} />
      </div>
    )
  }
  return (
    <button
      type="button"
      title="Open Thread"
      onClick={() => onOpenConversation(thread.value)}
      className="group/run w-full cursor-pointer rounded-row bg-surface-2 px-3 py-2.5 text-left smooth-shadow-ring-xs transition-surface duration-(--dur-fast) hover:bg-wash-hover"
    >
      <OccurrenceSummary
        occurrence={occurrence}
        trailing={
          <ChevronRight className="size-3.5 text-ink-4 transition-transform duration-(--dur-fast) group-hover/run:translate-x-0.5" />
        }
      />
    </button>
  )
}

/** One Occurrence: how it ended, when it started, and what Vivid said or what went wrong. */
function OccurrenceSummary({
  occurrence,
  trailing,
}: {
  occurrence: Occurrence
  trailing: ReactNode
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <i
          className={cn('size-2 shrink-0 rounded-full', OCCURRENCE[occurrence.status].dot)}
          aria-hidden
        />
        <span className="text-label text-ink">{OCCURRENCE[occurrence.status].label}</span>
        <time className="ml-auto text-meta font-meta text-ink-3 tabular-nums">
          {formatTime(occurrence.startedAt)}
        </time>
        {trailing}
      </div>
      {occurrence.output !== null && (
        <p className="mt-1 line-clamp-3 text-meta whitespace-pre-wrap text-ink-3">
          {occurrence.output}
        </p>
      )}
      {occurrence.error !== null && (
        <p className="mt-1 text-meta text-danger">{occurrence.error}</p>
      )}
    </>
  )
}
