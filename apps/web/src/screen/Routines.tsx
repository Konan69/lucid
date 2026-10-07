import { RoutineTrigger, type RoutineId, type RoutineWebhook, type Thread } from '@vivid/contracts'
import type { RuntimeConversation } from '@vivid/state'
import type { LiveStateOf } from '@vivid/state'
import { Data, Effect, Option, Redacted, Result } from 'effect'
import {
  AlertTriangle,
  ChevronRight,
  CalendarClock,
  Clock3,
  Link2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Repeat2,
  Webhook,
} from 'lucide-react'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { act } from '../data/app'
import { changing, live, LiveState, useLive, useLiveValue } from '../data/live'
import { routines as routinesData } from '@vivid/state'
import type { ProductFailure } from '../data/runtime'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import { Copy } from '../ui/Copy'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Field, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { useSurface } from '../ui/Layer'
import { Live } from '../ui/Live'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Textarea } from '../ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Alert } from '../ui/alert'
import { Segmented } from '../ui/Segmented'
import { SkeletonList } from '../ui/skeleton'
import { BAR } from './bar'
import { Emblem, type Hue } from './Emblem'
import { Mark } from './integration/Mark'
import { ENTER, PRESS, stagger } from './motion'

type Routine = routinesData.Routine
type Occurrence = routinesData.Occurrence
type RoutineFields = routinesData.RoutineFields

/**
 * What the screen is showing: the list, the form for a new Routine, or one Routine. Only this is
 * local; the Routines themselves are read from the live query every render.
 */
type View = Data.TaggedEnum<{
  Overview: {}
  /** The form opens on `start`: empty, or one of the list's suggestions already written out. */
  Creating: { readonly start: RoutineFields }
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
      <div className="min-h-0 flex-1 scroll-fade-y overflow-y-auto">
        <div className="mx-auto flex w-full max-w-230 flex-col gap-3 px-5 pt-1 pb-10 sm:px-8">
          {Option.isSome(refused) && <Alert variant="destructive">{refused.value}</Alert>}
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
        onCreate={(start) => onView(View.Creating({ start }))}
        onSelect={(routine) => onView(View.Detail({ id: routine.id }))}
      />
    ),
    Creating: ({ start }) => (
      <NewRoutine
        start={start}
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
/**
 * A Routine a new Person is likely to want, written out so starting one is a press and an edit,
 * not a blank form. The pattern is Grok Bot's "Suggestions" (job cards with the service's logo
 * in them, `refs/grok-bot-screenshots/03-create-your-first-bot.png`). The schedules are the
 * editor's own presets, so the form opens on a choice it can show.
 */
const STARTERS = [
  {
    name: 'Morning brief',
    prompt: 'Tell me what is on my calendar today and which emails need an answer.',
    cron: '0 9 * * 1-5',
    uses: ['Google Calendar', 'Gmail'],
  },
  {
    name: 'Inbox watch',
    prompt: 'Check my inbox and tell me only about what needs me today.',
    cron: '0 * * * *',
    uses: ['Gmail'],
  },
  {
    name: 'Week ahead',
    prompt: 'Write up what is coming this week: meetings, deadlines and what is still open.',
    cron: '0 9 * * 1',
    uses: ['Google Calendar', 'Notion'],
  },
] as const

function RoutinesOverview({
  state,
  onCreate,
  onSelect,
}: {
  state: RoutinesState
  /** Opens the form, on the fields given: empty ones, or a suggestion's. */
  onCreate: (start: RoutineFields) => void
  onSelect: (routine: Routine) => void
}) {
  const blank = () => onCreate(routinesData.emptyFields())
  // "Tomorrow at 9" is said against the moment the list was opened, read once: a render must
  // not read the clock, and a list left open past midnight is corrected by its next opening.
  const [opened] = useState(() => Date.now())
  return (
    <Live state={state} loading={<SkeletonList of="row" count={3} />}>
      {({ routines }) =>
        routines.length === 0 ? (
          <NoRoutines onCreate={onCreate} />
        ) : (
          <>
            <div className="flex items-center gap-2 px-0.5 pb-1">
              <p className="flex-1 text-label text-ink-3 tabular-nums">
                {routines.filter((routine) => routine.enabled).length} of {routines.length} on
              </p>
              <Button variant="outline" size="sm" onClick={blank}>
                <Plus className="size-3.5" />
                New routine
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {routines.map((routine, place) => (
                <li key={routine.id}>
                  <RoutineRow
                    routine={routine}
                    place={place}
                    now={opened}
                    onOpen={() => onSelect(routine)}
                  />
                </li>
              ))}
            </ul>
          </>
        )
      }
    </Live>
  )
}

/**
 * The list before there is anything in it: what a Routine is, in the place's own colour, and
 * three written-out ones to start from. Each suggestion shows the services it would read, as
 * their real logos, so a Person sees what it acts on before pressing it.
 */
function NoRoutines({ onCreate }: { onCreate: (start: RoutineFields) => void }) {
  return (
    <div className="flex flex-col items-center px-2 pt-10 text-center">
      <Emblem hue="orange" size={44}>
        <Repeat2 />
      </Emblem>
      <p className="mt-4 text-section font-title text-ink">No routines yet</p>
      <p className="mt-1 max-w-sm text-label text-pretty text-ink-3">
        Write an instruction once and Vivid follows it on a schedule, or each time something calls
        it.
      </p>
      <Button className="mt-5" onClick={() => onCreate(routinesData.emptyFields())}>
        <Plus className="size-3.5" />
        New routine
      </Button>
      <p className="mt-10 mb-2.5 self-start px-0.5 text-label font-title text-ink">
        Start from one
      </p>
      <ul className="grid w-full gap-2.5 text-left sm:grid-cols-3">
        {STARTERS.map((starter, place) => (
          <li key={starter.name}>
            <button
              type="button"
              onClick={() =>
                onCreate({
                  ...routinesData.emptyFields(),
                  name: starter.name,
                  prompt: starter.prompt,
                  cron: starter.cron,
                })
              }
              className={cn(
                'flex size-full cursor-pointer flex-col gap-2.5 rounded-card bg-surface-3 p-3.5 text-left edge outline-none hover:bg-surface-2 focus-visible:edge-primary',
                PRESS,
                ENTER,
                stagger(place),
              )}
            >
              <span className="flex -space-x-1.5">
                {starter.uses.map((name) => (
                  <span key={name} className="rounded-control ring-2 ring-surface-3">
                    <Mark service={{ name }} size={28} />
                  </span>
                ))}
              </span>
              <span className="text-title font-title text-ink">{starter.name}</span>
              <span className="text-label text-pretty text-ink-3">{starter.prompt}</span>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-1 text-meta font-meta text-ink-3">
                <Clock3 aria-hidden className="size-3.5" />
                {routinesData.describeCron(starter.cron)}
              </span>
            </button>
          </li>
        ))}
      </ul>
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

const DAY = 24 * 60 * 60 * 1000
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** The start of the day a moment falls in, in the browser's own zone. */
const dayOf = (moment: number) => new Date(moment).setHours(0, 0, 0, 0)

/**
 * When a Routine next runs, the way a person would say it: "Today at 4:30 PM", "Tomorrow at
 * 9:00 AM", "Friday at 9:00 AM", and a date only once it is more than a week away.
 */
function nextInWords(at: number, now: number): string {
  const days = Math.round((dayOf(at) - dayOf(now)) / DAY)
  const time = clock.format(at)
  if (days <= 0) return `Today at ${time}`
  if (days === 1) return `Tomorrow at ${time}`
  if (days < 7) return `${weekday.format(at)} at ${time}`
  return `${monthDay.format(at)} at ${time}`
}

/** The glyph and hue for each way a Routine starts on its own; a new trigger fails to compile here. */
const TRIGGER_MARK = {
  Schedule: { hue: 'orange', icon: <Clock3 /> },
  Webhook: { hue: 'violet', icon: <Webhook /> },
  Once: { hue: 'yellow', icon: <CalendarClock /> },
} as const satisfies Record<
  Exclude<RoutineTrigger['_tag'], 'Integration'>,
  { hue: Hue; icon: ReactNode }
>

/**
 * What a row leads with, which is what the Routine acts on: the real logo of the service it
 * watches, or a clock, a calendar day or a webhook on the trigger's own colour. A paused Routine
 * keeps its glyph and loses its colour, so the list still says what it is while saying it is off.
 */
function RoutineMark({ routine }: { routine: Routine }) {
  const { trigger } = routine
  if (RoutineTrigger.guards.Integration(trigger)) {
    return (
      <span className={cn(!routine.enabled && 'opacity-50 grayscale')}>
        <Mark service={{ name: trigger.account }} size={36} />
      </span>
    )
  }
  const mark = TRIGGER_MARK[trigger._tag]
  return (
    <Emblem hue={routine.enabled ? mark.hue : 'gray'} size={36}>
      {routine.enabled ? mark.icon : <Pause />}
    </Emblem>
  )
}

/** How a Routine stands right now, as the colour of its dot and one or two words. */
function standingOf(routine: Routine, running: boolean) {
  if (running) return { dot: 'animate-status-pulse bg-working', words: 'Running now' }
  if (!routine.enabled) return { dot: 'bg-ink-4', words: 'Paused' }
  return { dot: 'bg-success', words: 'On' }
}

/** One Routine in the list, as a card. The whole card opens it. */
function RoutineRow({
  routine,
  place,
  now,
  onOpen,
}: {
  routine: Routine
  /** Its place in the list, which is how long it waits before it arrives. */
  place: number
  /** The moment "today" and "tomorrow" are counted from. */
  now: number
  onOpen: () => void
}) {
  const troubled = Option.contains(latestStatus(routine), 'failed') || routine.lastMissedAt !== null
  const running = Option.contains(latestStatus(routine), 'running')
  const standing = standingOf(routine, running)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-card bg-surface-3 p-3 text-left edge outline-none hover:bg-surface-2 focus-visible:edge-primary',
        PRESS,
        ENTER,
        stagger(place),
      )}
    >
      <RoutineMark routine={routine} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title font-title text-ink">{routine.name}</span>
        <span className={cn('block truncate text-label', troubled ? 'text-danger' : 'text-ink-3')}>
          {routineSummary(routine)}
        </span>
      </span>
      <span className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
        <span className="inline-flex items-center gap-1.5 text-label text-ink-2">
          <i aria-hidden className={cn('size-1.5 rounded-full', standing.dot)} />
          {standing.words}
        </span>
        {routine.enabled && routine.nextRunAt !== null && (
          <time className="text-meta font-meta text-ink-3 tabular-nums">
            Runs {nextInWords(routine.nextRunAt, now)}
          </time>
        )}
      </span>
      {/* Narrow: there is no room for the words, so the dot alone says how it stands. */}
      <i aria-hidden className={cn('size-1.5 shrink-0 rounded-full sm:hidden', standing.dot)} />
      <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-4" />
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
  const fixed = routinesData.fixedStart(fields)
  // One id for the fieldset; each field adds its own word, so a label finds its control.
  const id = useId()
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
        <Input
          id={`${id}-name`}
          autoFocus={focusName}
          required
          maxLength={120}
          value={fields.name}
          onChange={(event) => onChange({ ...fields, name: event.currentTarget.value })}
          placeholder="Daily Project brief"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-instruction`}>Instruction</FieldLabel>
        <Textarea
          id={`${id}-instruction`}
          required
          maxLength={4000}
          rows={5}
          value={fields.prompt}
          onChange={(event) => onChange({ ...fields, prompt: event.currentTarget.value })}
          placeholder="Review what moved in the Project and write a short brief."
        />
      </Field>
      {Option.isSome(fixed) ? (
        // Set up by Vivid in conversation: an Integration it found the account and event for, or
        // one time it worked out from "tomorrow at 9". It is shown as it is; to change it, ask Vivid.
        <div className="flex flex-col items-start gap-1.5">
          <span className="text-label font-title text-ink-2">Starts</span>
          <p className="w-full rounded-card bg-surface-2 px-4 py-3 text-label text-ink-2">
            {fixed.value} <span className="text-ink-3">To change when it starts, ask Vivid.</span>
          </p>
        </div>
      ) : (
        <StartsOn fields={fields} zone={zone} onChange={onChange} />
      )}
    </>
  )
}

/** What starts a Routine the editor can set: a schedule, or an outside service calling it. */
function StartsOn({
  fields,
  zone,
  onChange,
}: {
  fields: routinesData.RoutineFields
  zone: string
  onChange: (fields: routinesData.RoutineFields) => void
}) {
  return (
    <>
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
        <p className="rounded-card bg-surface-2 px-4 py-3 text-label text-ink-3 edge">
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
  // One id for the fields; each adds its own word, so a label finds its control.
  const id = useId()
  // The named schedules, as the select reads them: the trigger's words come from this list.
  const named = routinesData.SCHEDULE_PRESETS.map((option) => ({
    value: option.cron,
    label: option.label,
  }))
  // A schedule written by hand has no name; it is listed so the select can show it.
  const schedules = preset ? named : [...named, { value: fields.cron, label: 'Its own schedule' }]
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-when`}>When</FieldLabel>
          <Select
            items={schedules}
            value={fields.cron}
            onValueChange={(cron) => {
              // Base UI hands `null` when a selection is cleared; nothing here clears one.
              if (cron === null) return
              onChange({ ...fields, cron })
            }}
          >
            <SelectTrigger id={`${id}-when`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {schedules.map((schedule) => (
                  <SelectItem key={schedule.value} value={schedule.value}>
                    {schedule.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-zone`}>Time zone</FieldLabel>
          <Input
            id={`${id}-zone`}
            required
            value={Option.getOrElse(fields.timezone, () => zone)}
            onChange={(event) =>
              onChange({ ...fields, timezone: Option.some(event.currentTarget.value) })
            }
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-cron`}>
          Cron expression{' '}
          <span className="font-meta text-ink-3">for a schedule not listed above</span>
        </FieldLabel>
        <Input
          id={`${id}-cron`}
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
  start,
  onCancel,
  onCreated,
  onRefused,
}: {
  /** What the form opens with. It is read once: after that the form is the Person's. */
  start: RoutineFields
  onCancel: () => void
  onCreated: (routine: Routine) => void
  onRefused: (message: Option.Option<string>) => void
}) {
  const zone = useZone()
  const [fields, setFields] = useState(start)
  const [saving, setSaving] = useState(false)

  function create(event: FormEvent) {
    return Effect.gen(function* () {
      event.preventDefault()
      setSaving(true)
      const result = yield* changing((client) =>
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
    })
  }

  return (
    <form onSubmit={(event) => void act(create(event))} className="space-y-4 pt-2">
      <RoutineFieldset fields={fields} zone={zone} focusName onChange={setFields} />
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !routinesData.fieldsComplete(fields, zone)}>
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
  // Only what the Person has changed is held here; the rest follows the live Routine.
  const [edits, setEdits] = useState(routinesData.noEdits)
  const fields = routinesData.editing(routine, edits)
  const setFields = (next: routinesData.RoutineFields) =>
    setEdits(routinesData.editsIn(routine, next))
  const savable =
    routinesData.fieldsComplete(fields, zone) && routinesData.fieldsDiffer(routine, fields, zone)

  /** The page shows the saved Routine at once; a refused save puts it back and says why. */
  function save(event: FormEvent) {
    return Effect.gen(function* () {
      event.preventDefault()
      const submitted: routinesData.RoutineFields = {
        ...fields,
        name: fields.name.trim(),
        prompt: fields.prompt.trim(),
      }
      const changes = {
        name: submitted.name,
        prompt: submitted.prompt,
        trigger: routinesData.triggerOf(submitted, zone),
      }
      const result = yield* changing(
        (client) => client.PatchRoutine({ id: routine.id, patch: changes }),
        () => live.routines.expect(routinesData.edited(routine.id, changes)),
      )
      // Keep edits made while the request was in flight; only the submitted values now live on the Routine.
      if (Result.isSuccess(result)) setEdits((current) => routinesData.unsaved(current, submitted))
      onRefused(refusal(result))
    })
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
      <form onSubmit={(event) => void act(save(event))} className="space-y-4">
        <RoutineFieldset fields={fields} zone={zone} focusName={false} onChange={setFields} />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={!savable}>
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

  function toggle() {
    return Effect.gen(function* () {
      const enabled = !routine.enabled
      const result = yield* changing(
        (client) => client.PatchRoutine({ id: routine.id, patch: { enabled } }),
        () => live.routines.expect(routinesData.enabledSet(routine.id, enabled)),
      )
      onRefused(refusal(result))
    })
  }

  function run() {
    return Effect.gen(function* () {
      setStarting(true)
      const result = yield* changing((client) => client.RunRoutine({ id: routine.id }))
      setStarting(false)
      onRefused(refusal(result))
    })
  }

  /** Leaves the page at once; if the server refuses, the Routine is back in the list. */
  function remove() {
    return Effect.gen(function* () {
      if (!window.confirm(`Delete “${routine.name}”? Its history goes with it.`)) return
      onBack()
      const result = yield* changing(
        (client) => client.DeleteRoutine({ id: routine.id }),
        () => live.routines.expect(routinesData.removed(routine.id)),
      )
      onRefused(refusal(result))
    })
  }

  return (
    <div className="mb-5 border-b border-line-1 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => void act(toggle())}>
          {routine.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {routine.enabled ? 'Pause' : 'Resume'}
        </Button>
        <Button disabled={starting || running} onClick={() => void act(run())}>
          {retry ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}
          {starting || running ? 'Running' : 'Run now'}
        </Button>
        {RoutineTrigger.guards.Webhook(routine.trigger) && (
          <WebhookAddress routine={routine} onRefused={onRefused} />
        )}
        <button
          type="button"
          onClick={() => void act(remove())}
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

  function ask() {
    return Effect.gen(function* () {
      setAsking(true)
      const result = yield* changing((client) => client.IssueRoutineWebhook({ id: routine.id }))
      setAsking(false)
      onRefused(refusal(result))
      if (Result.isSuccess(result)) setIssued(Option.some(result.success))
    })
  }

  return (
    <>
      <Button variant="outline" disabled={asking} onClick={() => void act(ask())}>
        <Link2 className="size-3.5" />
        Get address
      </Button>
      {Option.isSome(issued) && (
        <IssuedAddress
          name={routine.name}
          webhook={issued.value}
          onClose={() => setIssued(Option.none())}
        />
      )}
    </>
  )
}

/**
 * The address and key just issued, shown once. It is its own component so the dialog is open from
 * its first render and plays out when sent away (`useSurface`); only then is the key dropped, by
 * `onClose`, so the words do not vanish from a dialog that is still leaving.
 */
function IssuedAddress({
  name,
  webhook,
  onClose,
}: {
  name: string
  webhook: RoutineWebhook
  onClose: () => void
}) {
  const surface = useSurface(onClose)
  return (
    <Dialog {...surface}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Address for ${name}`}</DialogTitle>
          <DialogDescription>
            Send a POST request to the address, with the key as a bearer token in the Authorization
            header.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Copyable label="Address" name="the address" read={() => webhook.address} />
          <Copyable label="Key" name="the key" read={() => Redacted.value(webhook.key)} />
          <p className="text-label text-ink-2">
            The key is shown only now. Copy it before you close this. Getting the address again
            replaces the key.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      <div className="rounded-row bg-surface-2 px-3 py-2.5 edge">
        <OccurrenceSummary occurrence={occurrence} trailing={null} />
      </div>
    )
  }
  return (
    // The row shows what happened, not where a press leads; the tooltip says it opens the Thread.
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onOpenConversation(thread.value)}
            className="group/run w-full cursor-pointer rounded-row bg-surface-2 px-3 py-2.5 text-left edge transition-surface duration-(--dur-fast) hover:bg-wash-hover"
          />
        }
      >
        <OccurrenceSummary
          occurrence={occurrence}
          trailing={
            <ChevronRight className="size-3.5 text-ink-4 transition-transform duration-(--dur-fast) group-hover/run:translate-x-0.5" />
          }
        />
      </TooltipTrigger>
      <TooltipContent>Open Thread</TooltipContent>
    </Tooltip>
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
