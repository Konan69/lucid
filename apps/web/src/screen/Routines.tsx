import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  Repeat2,
  RotateCcw,
  Search,
  ShieldCheck,
  Star,
  Store,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import * as routinesData from '../data/routines'
import { run as runClient } from '../data/runtime'
import { plainPreview, type RuntimeConversation } from '../data/runtimeConversations'
import { cn } from '../ui/cn'

type RoutineTemplate = routinesData.RoutineTemplate
type ScheduledRoutine = routinesData.ScheduledRoutine
const templates = routinesData.templates

const brandText = {
  accent: 'text-accent-ink bg-accent-soft',
  working: 'text-working bg-working-soft',
  approve: 'text-approve bg-approve-soft',
  success: 'text-success bg-success-soft',
} satisfies Record<RoutineTemplate['brandColor'], string>

function describeCron(cron: string) {
  const known = new Map([
    ['0 * * * *', 'Every hour'],
    ['0 9 * * *', 'Every day at 9:00 AM'],
    ['0 9 * * 1-5', 'Weekdays at 9:00 AM'],
    ['0 9 * * 1', 'Mondays at 9:00 AM'],
  ])
  return known.get(cron) ?? `Cron ${cron}`
}

function formatTime(value: number | null) {
  if (value == null) return 'Paused'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    value,
  )
}

export function Routines({
  onOpenConversation,
}: {
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  const [routines, setRoutines] = useState<ScheduledRoutine[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [templateId, setTemplateId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const result = await runClient(routinesData.load())
    setReady(true)
    if (result._tag === 'Failure') {
      switch (result.failure._tag) {
        case 'ClientRequestFailed':
          setError(result.failure.message)
          return
      }
    }
    setRoutines(result.success)
    setError(null)
  }, [])

  useEffect(() => {
    let cancelled = false

    // The first request hydrates the screen from the runtime; later refreshes still use `load`
    // from explicit mutations and the running-routine poll below.
    void runClient(routinesData.load()).then((result) => {
      if (cancelled) return
      setReady(true)
      if (result._tag === 'Failure') {
        switch (result.failure._tag) {
          case 'ClientRequestFailed':
            setError(result.failure.message)
            return
        }
      }
      setRoutines(result.success)
      setError(null)
    })

    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!routines.some((routine) => routine.runs.some((run) => run.status === 'running')))
      return undefined
    const timer = window.setInterval(() => {
      void load()
    }, 1500)
    return () => window.clearInterval(timer)
  }, [load, routines])

  const selected = routines.find((routine) => routine.id === selectedId) ?? null
  const template = templates.find((item) => item.id === templateId) ?? null
  const inDetail = selected != null || creating || template != null
  const back = () => {
    setSelectedId(null)
    setCreating(false)
    setTemplateId(null)
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0 content-edge">
      <RoutinesHeader
        inDetail={inDetail}
        selected={selected}
        creating={creating}
        template={template}
        onBack={back}
      />

      <RoutinesContent
        error={error}
        template={template}
        selected={selected}
        creating={creating}
        routines={routines}
        ready={ready}
        onOpenConversation={onOpenConversation}
        onBack={back}
        onCreate={() => setCreating(true)}
        onSelectRoutine={setSelectedId}
        onSelectTemplate={setTemplateId}
        onChanged={async (id) => {
          await load()
          setCreating(false)
          setSelectedId(id)
        }}
        onDeleted={async () => {
          back()
          await load()
        }}
      />
    </section>
  )
}

/** Renders detail navigation without making the screen component own title branching. */
function RoutinesHeader({
  inDetail,
  selected,
  creating,
  template,
  onBack,
}: {
  inDetail: boolean
  selected: ScheduledRoutine | null
  creating: boolean
  template: RoutineTemplate | null
  onBack: () => void
}) {
  return (
    <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
      {inDetail && (
        <button
          onClick={onBack}
          aria-label="Back to routines"
          className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <ChevronRight className="size-4 rotate-180" />
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">
        {template
          ? template.name
          : selected
            ? selected.name
            : creating
              ? 'New routine'
              : 'Routines'}
      </h1>
      {!inDetail && (
        <button
          aria-label="Search routines"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <Search className="size-4" />
        </button>
      )}
    </header>
  )
}

/** Selects the detail, editor, or overview body inside the unchanged scrolling container. */
function RoutinesContent({
  error,
  template,
  selected,
  creating,
  routines,
  ready,
  onOpenConversation,
  onBack,
  onCreate,
  onSelectRoutine,
  onSelectTemplate,
  onChanged,
  onDeleted,
}: {
  error: string | null
  template: RoutineTemplate | null
  selected: ScheduledRoutine | null
  creating: boolean
  routines: ScheduledRoutine[]
  ready: boolean
  onOpenConversation: (conversation: RuntimeConversation) => void
  onBack: () => void
  onCreate: () => void
  onSelectRoutine: (id: string) => void
  onSelectTemplate: (id: string) => void
  onChanged: (id: string) => Promise<void>
  onDeleted: () => Promise<void>
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
      <div className="mx-auto w-full max-w-230 px-5 pt-1 pb-10 sm:px-8">
        {error && (
          <div
            className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger"
            role="alert"
          >
            {error}
          </div>
        )}
        {template ? (
          <TemplateDetail template={template} />
        ) : selected || creating ? (
          <RoutineEditor
            routine={selected}
            onOpenConversation={onOpenConversation}
            onCancel={onBack}
            onChanged={onChanged}
            onDeleted={onDeleted}
          />
        ) : (
          <RoutinesOverview
            routines={routines}
            ready={ready}
            onCreate={onCreate}
            onSelectRoutine={onSelectRoutine}
            onSelectTemplate={onSelectTemplate}
          />
        )}
      </div>
    </div>
  )
}

/** Renders the routine list and template gallery as one overview fragment. */
function RoutinesOverview({
  routines,
  ready,
  onCreate,
  onSelectRoutine,
  onSelectTemplate,
}: {
  routines: ScheduledRoutine[]
  ready: boolean
  onCreate: () => void
  onSelectRoutine: (id: string) => void
  onSelectTemplate: (id: string) => void
}) {
  return (
    <>
      <p className="px-0.5 text-meta font-meta text-ink-4">
        What Vivid repeats, so you don&apos;t have to.
      </p>
      <Section
        title="Your routines"
        note={`${routines.length} routines · ${routines.reduce((count, routine) => count + routine.runs.length, 0)} recent runs`}
      >
        <RoutineList
          routines={routines}
          ready={ready}
          onCreate={onCreate}
          onSelect={onSelectRoutine}
        />
      </Section>

      <Section title="Template gallery" note="Starting points for common recurring work.">
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {templates.map((item) => (
            <TemplateCard key={item.id} template={item} onOpen={() => onSelectTemplate(item.id)} />
          ))}
        </ul>
        <div className="mt-4 flex items-center gap-2 rounded-card bg-surface-2 p-4 smooth-shadow-ring-xs">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
            <Store className="size-4.5" strokeWidth={1.7} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-label font-title text-ink">Build from a template</span>
            <span className="block text-meta font-meta text-ink-4">
              Templates provide instructions. Your own schedule and access stay private.
            </span>
          </span>
        </div>
      </Section>
    </>
  )
}

/** Renders loading, empty, and populated routine states without branching in the overview. */
function RoutineList({
  routines,
  ready,
  onCreate,
  onSelect,
}: {
  routines: ScheduledRoutine[]
  ready: boolean
  onCreate: () => void
  onSelect: (id: string) => void
}) {
  return (
    <>
      {!ready ? (
        <div className="flex items-center gap-2 px-2.5 py-5 text-label text-ink-4">
          <LoaderCircle className="size-4 animate-spin" />
          Loading routines…
        </div>
      ) : routines.length === 0 ? (
        <div className="rounded-card bg-surface-2 px-4 py-6 text-center smooth-shadow-ring-xs">
          <Clock3 className="mx-auto size-5 text-ink-4" />
          <p className="mt-2 text-label text-ink-3">
            No routines yet. Create one to dispatch scheduled work to Vivid.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-px">
          {routines.map((routine) => (
            <RoutineRow key={routine.id} routine={routine} onOpen={() => onSelect(routine.id)} />
          ))}
        </ul>
      )}
      <button
        onClick={onCreate}
        className="mt-1 flex w-full items-center gap-2.5 rounded-row p-2.5 text-left text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2">
          <Plus className="size-4" />
        </span>
        <span className="text-title">New routine</span>
      </button>
    </>
  )
}

/** Selects the routine subtitle from failure, missed-run, enabled, and paused states. */
function routineSummary(routine: ScheduledRoutine, failed: boolean): string {
  if (failed) return 'Last run failed · open to retry'
  if (routine.lastMissedAt) return `Missed ${formatTime(routine.lastMissedAt)}`
  if (routine.enabled) return `${describeCron(routine.cron)} · ${routine.timezone}`
  return 'Paused'
}

/** Keeps the mutually exclusive running, enabled, and paused icons out of the row component. */
function RoutineStateIcon({ running, enabled }: { running: boolean; enabled: boolean }) {
  if (running) return <LoaderCircle className="size-4 animate-spin" />
  if (enabled) return <Clock3 className="size-4" />
  return <Pause className="size-4" />
}

/** Derives one routine's latest-run treatment before rendering the unchanged row markup. */
function RoutineRow({ routine, onOpen }: { routine: ScheduledRoutine; onOpen: () => void }) {
  const latestRun = routine.runs[0]
  const running = latestRun !== undefined && latestRun.status === 'running'
  const failed = latestRun !== undefined && latestRun.status === 'failed'
  return (
    <li>
      <button
        onClick={onOpen}
        className="group/row flex w-full items-center gap-2.5 rounded-row p-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover"
      >
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
          <RoutineStateIcon running={running} enabled={routine.enabled} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-title text-ink">{routine.name}</span>
          <span
            className={cn(
              'block truncate text-meta font-meta',
              failed || routine.lastMissedAt ? 'text-danger' : 'text-ink-4',
            )}
          >
            {routineSummary(routine, failed)}
          </span>
        </span>
        <span className="hidden text-right text-meta font-meta text-ink-4 sm:block">
          {routine.enabled ? (
            <>
              Next
              <br />
              {formatTime(routine.nextRunAt)}
            </>
          ) : (
            'Paused'
          )}
        </span>
        <i
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            routine.enabled ? 'bg-success' : 'bg-ink-4',
          )}
          aria-label={routine.enabled ? 'Active' : 'Paused'}
        />
      </button>
    </li>
  )
}

function RoutineEditor({
  routine,
  onChanged,
  onDeleted,
  onCancel,
  onOpenConversation,
}: {
  routine: ScheduledRoutine | null
  onChanged: (id: string) => Promise<void>
  onDeleted: () => Promise<void>
  onCancel: () => void
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  const [name, setName] = useState(routine === null ? '' : routine.name)
  const [prompt, setPrompt] = useState(routine === null ? '' : routine.prompt)
  const [cron, setCron] = useState(routine === null ? '0 9 * * 1-5' : routine.cron)
  const [timezone, setTimezone] = useState(
    routine === null ? Intl.DateTimeFormat().resolvedOptions().timeZone : routine.timezone,
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestRun = routine === null ? null : (routine.runs[0] ?? null)
  const running = latestRun !== null && latestRun.status === 'running'
  const needsRetry =
    (latestRun !== null && latestRun.status === 'failed') ||
    (routine !== null && routine.lastMissedAt !== null)

  async function execute<Value>(program: routinesData.Program<Value>) {
    setPending(true)
    setError(null)
    const result = await runClient(program)
    setPending(false)
    if (result._tag === 'Failure') {
      switch (result.failure._tag) {
        case 'ClientRequestFailed':
          setError(result.failure.message)
          return null
      }
    }
    return result.success
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    const input = { name, prompt, cron, timezone } satisfies routinesData.RoutineInput
    const saved =
      routine === null
        ? await execute(routinesData.create(input))
        : await execute(routinesData.update(routine.id, input))
    if (saved !== null) await onChanged(saved.id)
  }

  async function toggle() {
    if (!routine) return
    const saved = await execute(routinesData.setEnabled(routine.id, !routine.enabled))
    if (saved !== null) await onChanged(saved.id)
  }

  async function runNow() {
    if (!routine) return
    if ((await execute(routinesData.runNow(routine.id))) !== null) {
      await onChanged(routine.id)
    }
  }

  async function remove() {
    if (
      !routine ||
      !window.confirm(`Delete “${routine.name}”? Its run history will also be removed.`)
    )
      return
    if ((await execute(routinesData.remove(routine.id))) !== null) {
      await onDeleted()
    }
  }

  return (
    <div className="pt-2">
      <RoutineEditorControls
        routine={routine}
        pending={pending}
        running={running}
        needsRetry={needsRetry}
        onToggle={() => void toggle()}
        onRun={() => void runNow()}
        onRemove={() => void remove()}
      />
      <RoutineMissedNotice routine={routine} />
      <RoutineEditorForm
        routine={routine}
        name={name}
        prompt={prompt}
        cron={cron}
        timezone={timezone}
        pending={pending}
        error={error}
        onNameChange={setName}
        onPromptChange={setPrompt}
        onCronChange={setCron}
        onTimezoneChange={setTimezone}
        onSubmit={(event) => void save(event)}
        onCancel={onCancel}
      />
      <RoutineHistory routine={routine} onOpenConversation={onOpenConversation} />
    </div>
  )
}

/** Renders mutation controls only for an existing routine. */
function RoutineEditorControls({
  routine,
  pending,
  running,
  needsRetry,
  onToggle,
  onRun,
  onRemove,
}: {
  routine: ScheduledRoutine | null
  pending: boolean
  running: boolean
  needsRetry: boolean
  onToggle: () => void
  onRun: () => void
  onRemove: () => void
}) {
  if (routine === null) return null
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-line-1 pb-4">
      <button
        disabled={pending}
        onClick={onToggle}
        className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs disabled:opacity-50"
      >
        {routine.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        {routine.enabled ? 'Pause' : 'Resume'}
      </button>
      <button
        disabled={pending || running}
        onClick={onRun}
        className="inline-flex h-8 items-center gap-1.5 rounded-control bg-accent px-3 text-label font-title text-ink-on-accent disabled:opacity-50"
      >
        {running ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : needsRetry ? (
          <RotateCcw className="size-3.5" />
        ) : (
          <Play className="size-3.5" />
        )}
        {running ? 'Running…' : needsRetry ? 'Retry now' : 'Test run'}
      </button>
      <button
        disabled={pending}
        onClick={onRemove}
        className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-label text-danger hover:bg-danger-soft disabled:opacity-50"
      >
        <Trash2 className="size-3.5" />
        Delete
      </button>
    </div>
  )
}

/** Shows the durable missed-run warning only when the runtime reported a missed timestamp. */
function RoutineMissedNotice({ routine }: { routine: ScheduledRoutine | null }) {
  if (routine === null || routine.lastMissedAt === null) return null
  return (
    <div className="mb-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-label text-danger">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p>
        Vivid was offline for the expected run at {formatTime(routine.lastMissedAt)}. It was not
        silently replayed. Retry it when ready.
      </p>
    </div>
  )
}

/** Renders routine fields and submit controls while the editor owns their state. */
function RoutineEditorForm({
  routine,
  name,
  prompt,
  cron,
  timezone,
  pending,
  error,
  onNameChange,
  onPromptChange,
  onCronChange,
  onTimezoneChange,
  onSubmit,
  onCancel,
}: {
  routine: ScheduledRoutine | null
  name: string
  prompt: string
  cron: string
  timezone: string
  pending: boolean
  error: string | null
  onNameChange: (value: string) => void
  onPromptChange: (value: string) => void
  onCronChange: (value: string) => void
  onTimezoneChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-label font-title text-ink-2">Name</span>
        <input
          required
          maxLength={120}
          value={name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder="Daily project brief"
          className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs outline-none focus:smooth-shadow-ring-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-label font-title text-ink-2">Instruction</span>
        <textarea
          required
          maxLength={4000}
          rows={5}
          value={prompt}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          placeholder="Review recent project activity and prepare a concise brief."
          className="w-full resize-y rounded-control bg-surface-2 px-3 py-2.5 text-label text-ink smooth-shadow-ring-xs outline-none focus:smooth-shadow-ring-sm"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-label font-title text-ink-2">When to run</span>
          <select
            value={cron}
            onChange={(event) => onCronChange(event.currentTarget.value)}
            className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs"
          >
            <option value="0 * * * *">Every hour</option>
            <option value="0 9 * * *">Every day at 9:00 AM</option>
            <option value="0 9 * * 1-5">Weekdays at 9:00 AM</option>
            <option value="0 9 * * 1">Mondays at 9:00 AM</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-label font-title text-ink-2">Timezone</span>
          <input
            required
            value={timezone}
            onChange={(event) => onTimezoneChange(event.currentTarget.value)}
            className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-meta font-meta text-ink-4">
          Advanced cron expression
        </span>
        <input
          required
          value={cron}
          onChange={(event) => onCronChange(event.currentTarget.value)}
          className="h-9 w-full rounded-control bg-surface-2 px-3 font-mono text-meta text-ink smooth-shadow-ring-xs"
        />
      </label>
      {error && (
        <p className="text-label text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover"
        >
          Cancel
        </button>
        <button
          disabled={pending}
          className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent disabled:opacity-50"
        >
          {pending && <LoaderCircle className="size-3.5 animate-spin" />}
          {routine ? 'Save changes' : 'Create routine'}
        </button>
      </div>
    </form>
  )
}

/** Renders run history only when editing an existing routine. */
function RoutineHistory({
  routine,
  onOpenConversation,
}: {
  routine: ScheduledRoutine | null
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  if (routine === null) return null
  return (
    <div className="mt-7 border-t border-line-1 pt-4">
      <h2 className="text-label font-title text-ink-2">Run history</h2>
      {routine.runs.length === 0 ? (
        <p className="mt-2 text-label text-ink-4">No runs yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {routine.runs.map((run) => (
            <RoutineRunRow
              key={run.id}
              run={run}
              routine={routine}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** Projects one run into the conversation record opened by its history row. */
function RoutineRunRow({
  run,
  routine,
  onOpenConversation,
}: {
  run: ScheduledRoutine['runs'][number]
  routine: ScheduledRoutine
  onOpenConversation: (conversation: RuntimeConversation) => void
}) {
  return (
    <li>
      <button
        type="button"
        title="Open conversation"
        onClick={() =>
          onOpenConversation({
            id: run.conversationId,
            title: routine.name,
            preview: plainPreview(run.output ?? run.error ?? routine.prompt),
            updatedAt: run.finishedAt ?? run.startedAt,
            archived: false,
          })
        }
        className="group/run w-full rounded-row bg-surface-2 px-3 py-2.5 text-left smooth-shadow-ring-xs transition-surface hover:bg-wash-hover hover:smooth-shadow-ring-sm"
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2 rounded-full',
              run.status === 'succeeded'
                ? 'bg-success'
                : run.status === 'failed'
                  ? 'bg-danger'
                  : 'animate-pulse bg-working',
            )}
          />
          <span className="text-label text-ink capitalize">{run.status}</span>
          <time className="ml-auto text-meta font-meta text-ink-4">
            {formatTime(run.startedAt)}
          </time>
          <ChevronRight className="size-3.5 text-ink-4 transition-transform group-hover/run:translate-x-0.5" />
        </div>
        {run.output && (
          <p className="mt-1 line-clamp-3 text-meta whitespace-pre-wrap text-ink-3">{run.output}</p>
        )}
        {run.error && <p className="mt-1 text-meta text-danger">{run.error}</p>}
      </button>
    </li>
  )
}

function TemplateCard({
  template: item,
  onOpen,
}: {
  template: RoutineTemplate
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      className="group/card flex h-full flex-col rounded-card bg-surface-2 p-4 text-left smooth-shadow-ring-xs transition-surface duration-(--dur-fast) hover:bg-wash-hover hover:smooth-shadow-ring-sm"
    >
      <span className="flex h-6 items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-meta font-title',
            brandText[item.brandColor],
          )}
        >
          {item.publisher}
        </span>
        <span className="flex-1" />
        <span className="text-meta font-title text-ink">{item.price}</span>
      </span>
      <span className="mt-2.5 block text-title text-ink">{item.name}</span>
      <span className="mt-0.5 line-clamp-2 text-label text-ink-3">{item.summary}</span>
      <span className="mt-auto flex items-center gap-2 pt-3 text-meta font-meta text-ink-4">
        <Star className="size-3.5 fill-current text-approve" />
        {item.rating}
        <span>·</span>
        {item.installs} using it
        <ChevronRight className="ml-auto size-3.5 transition-transform duration-(--dur-fast) group-hover/card:translate-x-0.5" />
      </span>
    </button>
  )
}

function TemplateDetail({ template: item }: { template: RoutineTemplate }) {
  return (
    <div className="pt-2">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'inline-flex size-12 shrink-0 items-center justify-center rounded-control',
            brandText[item.brandColor],
          )}
        >
          <Repeat2 className="size-6" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-page font-title text-ink">{item.name}</h2>
          <p className="text-label text-ink-3">{item.summary}</p>
          <p className="mt-1 text-meta font-meta text-ink-4">
            by {item.publisher} · {item.installs} using it · ★ {item.rating}
          </p>
        </div>
        <div className="text-right">
          <p className="text-title font-title text-ink">{item.price}</p>
        </div>
      </div>
      <div className="mt-6 border-t border-line-1 pt-4">
        <h3 className="text-label font-title text-ink-2">What it does</h3>
        <p className="mt-1 px-0.5 text-meta font-meta text-ink-4">{item.trigger}</p>
        <ol className="mt-2 flex flex-col gap-2">
          {item.actions.map((action, index) => (
            <li
              key={action}
              className="flex items-center gap-3 rounded-row bg-surface-2 px-3 py-2.5 smooth-shadow-ring-xs"
            >
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-meta font-meta text-ink-2">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 text-label text-ink">{action}</span>
              {index === item.actions.length - 1 && (
                <Check className="size-4 shrink-0 text-success" />
              )}
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-5 flex items-start gap-3 rounded-card bg-surface-2 p-4 smooth-shadow-ring-xs">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <p className="text-meta text-ink-3">
          Runs inside your Vivid. The template supplies instructions, not access to your data.
        </p>
      </div>
    </div>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-7">
      <div className="mb-1 flex items-baseline gap-2.5 border-t border-line-1 px-0.5 pt-4">
        <h2 className="text-label font-title text-ink-2">{title}</h2>
        {note && <p className="truncate text-meta font-meta text-ink-4">{note}</p>}
      </div>
      {children}
    </div>
  )
}
