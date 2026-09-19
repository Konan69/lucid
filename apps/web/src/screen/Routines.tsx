import {
  AlertTriangle, Check, ChevronRight, Clock3, LoaderCircle, Pause, Play, Plus, Repeat2, RotateCcw,
  Search, ShieldCheck, Star, Store, Trash2,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { templates, type RoutineTemplate } from "../data/routines";
import { plainPreview, type RuntimeConversation } from "../data/runtimeConversations";
import { cn } from "../ui/cn";

type RoutineRun = {
  id: string;
  conversationId: string;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt: number | null;
  output: string | null;
  error: string | null;
};

type ScheduledRoutine = {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  lastMissedAt: number | null;
  nextRunAt: number | null;
  runs: RoutineRun[];
};

const brandText = {
  accent: "text-accent-ink bg-accent-soft",
  working: "text-working bg-working-soft",
  approve: "text-approve bg-approve-soft",
  success: "text-success bg-success-soft",
} satisfies Record<RoutineTemplate["brandColor"], string>;

const RoutineRunSchema = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed"]),
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
const ScheduledRoutineSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  cron: Schema.String,
  timezone: Schema.String,
  enabled: Schema.Boolean,
  lastMissedAt: Schema.NullOr(Schema.Number),
  nextRunAt: Schema.NullOr(Schema.Number),
  runs: Schema.mutable(Schema.Array(RoutineRunSchema)),
});
const RoutinesResponseSchema = Schema.fromJsonString(Schema.Struct({ routines: Schema.mutable(Schema.Array(ScheduledRoutineSchema)) }));
const RoutineResponseSchema = Schema.fromJsonString(Schema.Struct({ routine: ScheduledRoutineSchema }));
const ErrorResponseSchema = Schema.fromJsonString(Schema.Struct({ error: Schema.optional(Schema.String) }));

async function request<T>(path: string, decode: (input: string) => T, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = Schema.decodeUnknownOption(ErrorResponseSchema)(await response.text());
    const message = body._tag === "Some" && body.value.error ? body.value.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return decode(await response.text());
}

function emptyResponse(): void {}

function describeCron(cron: string) {
  const known = new Map([
    ["0 * * * *", "Every hour"],
    ["0 9 * * *", "Every day at 9:00 AM"],
    ["0 9 * * 1-5", "Weekdays at 9:00 AM"],
    ["0 9 * * 1", "Mondays at 9:00 AM"],
  ]);
  return known.get(cron) ?? `Cron ${cron}`;
}

function formatTime(value: number | null) {
  if (value == null) return "Paused";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

export function Routines({ onOpenConversation }: { onOpenConversation: (conversation: RuntimeConversation) => void }) {
  const [routines, setRoutines] = useState<ScheduledRoutine[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await request("/api/routines", Schema.decodeUnknownSync(RoutinesResponseSchema));
      setRoutines(body.routines);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load routines");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // The first request hydrates the screen from the runtime; later refreshes still use `load`
    // from explicit mutations and the running-routine poll below.
    void request("/api/routines", Schema.decodeUnknownSync(RoutinesResponseSchema)).then((body) => {
      if (cancelled) return;
      setRoutines(body.routines);
      setError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load routines");
    }).finally(() => {
      if (!cancelled) setReady(true);
    });

    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!routines.some((routine) => routine.runs.some((run) => run.status === "running"))) return;
    const timer = window.setInterval(() => { void load(); }, 1500);
    return () => window.clearInterval(timer);
  }, [load, routines]);

  const selected = routines.find((routine) => routine.id === selectedId) ?? null;
  const template = templates.find((item) => item.id === templateId) ?? null;
  const inDetail = selected != null || creating || template != null;
  const back = () => {
    setSelectedId(null);
    setCreating(false);
    setTemplateId(null);
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        {inDetail && <button onClick={back} aria-label="Back to routines" className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><ChevronRight className="size-4 rotate-180" /></button>}
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{template ? template.name : selected ? selected.name : creating ? "New routine" : "Routines"}</h1>
        {!inDetail && <button aria-label="Search routines" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><Search className="size-4" /></button>}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-230 px-5 pt-1 pb-10 sm:px-8">
          {error && <div className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger" role="alert">{error}</div>}
          {template ? <TemplateDetail template={template} /> : selected || creating ? (
            <RoutineEditor routine={selected} onOpenConversation={onOpenConversation} onCancel={back} onChanged={async (id) => { await load(); setCreating(false); setSelectedId(id); }} onDeleted={async () => { back(); await load(); }} />
          ) : (
            <>
              <p className="px-0.5 text-meta font-meta text-ink-4">What Vivid repeats, so you don&apos;t have to.</p>
              <Section title="Your routines" note={`${routines.length} routines · ${routines.reduce((count, routine) => count + routine.runs.length, 0)} recent runs`}>
                {!ready ? <div className="flex items-center gap-2 px-2.5 py-5 text-label text-ink-4"><LoaderCircle className="size-4 animate-spin" />Loading routines…</div> : routines.length === 0 ? (
                  <div className="rounded-card bg-surface-2 px-4 py-6 text-center shadow-ring-xs"><Clock3 className="mx-auto size-5 text-ink-4" /><p className="mt-2 text-label text-ink-3">No routines yet. Create one to dispatch scheduled work to Vivid.</p></div>
                ) : (
                  <ul className="flex flex-col gap-px">
                    {routines.map((routine) => {
                      const latestRun = routine.runs[0];
                      const running = latestRun !== undefined && latestRun.status === "running";
                      const failed = latestRun !== undefined && latestRun.status === "failed";
                      return <li key={routine.id}><button onClick={() => setSelectedId(routine.id)} className="group/row flex w-full items-center gap-2.5 rounded-row p-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover">
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">{running ? <LoaderCircle className="size-4 animate-spin" /> : routine.enabled ? <Clock3 className="size-4" /> : <Pause className="size-4" />}</span>
                        <span className="min-w-0 flex-1"><span className="block truncate text-title text-ink">{routine.name}</span><span className={cn("block truncate text-meta font-meta", failed || routine.lastMissedAt ? "text-danger" : "text-ink-4")}>{failed ? "Last run failed · open to retry" : routine.lastMissedAt ? `Missed ${formatTime(routine.lastMissedAt)}` : routine.enabled ? `${describeCron(routine.cron)} · ${routine.timezone}` : "Paused"}</span></span>
                        <span className="hidden text-right text-meta font-meta text-ink-4 sm:block">{routine.enabled ? <>Next<br />{formatTime(routine.nextRunAt)}</> : "Paused"}</span>
                        <i className={cn("size-1.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-ink-4")} aria-label={routine.enabled ? "Active" : "Paused"} />
                      </button></li>;
                    })}
                  </ul>
                )}
                <button onClick={() => setCreating(true)} className="mt-1 flex w-full items-center gap-2.5 rounded-row p-2.5 text-left text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"><span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2"><Plus className="size-4" /></span><span className="text-title">New routine</span></button>
              </Section>

              <Section title="Template gallery" note="Starting points for common recurring work.">
                <ul className="grid gap-2.5 sm:grid-cols-2">{templates.map((item) => <TemplateCard key={item.id} template={item} onOpen={() => setTemplateId(item.id)} />)}</ul>
                <div className="mt-4 flex items-center gap-2 rounded-card bg-surface-2 p-4 shadow-ring-xs"><span className="inline-flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink"><Store className="size-4.5" strokeWidth={1.7} /></span><span className="min-w-0 flex-1"><span className="block text-label font-title text-ink">Build from a template</span><span className="block text-meta font-meta text-ink-4">Templates provide instructions. Your own schedule and access stay private.</span></span></div>
              </Section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function RoutineEditor({ routine, onChanged, onDeleted, onCancel, onOpenConversation }: { routine: ScheduledRoutine | null; onChanged: (id: string) => Promise<void>; onDeleted: () => Promise<void>; onCancel: () => void; onOpenConversation: (conversation: RuntimeConversation) => void }) {
  const [name, setName] = useState(routine === null ? "" : routine.name);
  const [prompt, setPrompt] = useState(routine === null ? "" : routine.prompt);
  const [cron, setCron] = useState(routine === null ? "0 9 * * 1-5" : routine.cron);
  const [timezone, setTimezone] = useState(routine === null ? Intl.DateTimeFormat().resolvedOptions().timeZone : routine.timezone);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestRun = routine === null ? null : routine.runs[0] ?? null;
  const running = latestRun !== null && latestRun.status === "running";
  const needsRetry = (latestRun !== null && latestRun.status === "failed") || (routine !== null && routine.lastMissedAt !== null);

  async function mutate(path: string, init: RequestInit) {
    setPending(true);
    setError(null);
    try { return await request(path, Schema.decodeUnknownSync(RoutineResponseSchema), init); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save routine"); throw cause; }
    finally { setPending(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      const body = await mutate(routine ? `/api/routines/${routine.id}` : "/api/routines", { method: routine ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, prompt, cron, timezone }) });
      await onChanged(body.routine.id);
    } catch { /* Error is displayed in the editor. */ }
  }

  async function toggle() {
    if (!routine) return;
    try { await mutate(`/api/routines/${routine.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !routine.enabled }) }); await onChanged(routine.id); }
    catch { /* Error is displayed in the editor. */ }
  }

  async function runNow() {
    if (!routine) return;
    setPending(true); setError(null);
    try { await request(`/api/routines/${routine.id}/run`, emptyResponse, { method: "POST" }); await onChanged(routine.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start routine"); }
    finally { setPending(false); }
  }

  async function remove() {
    if (!routine || !window.confirm(`Delete “${routine.name}”? Its run history will also be removed.`)) return;
    setPending(true);
    try { await request(`/api/routines/${routine.id}`, emptyResponse, { method: "DELETE" }); await onDeleted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete routine"); setPending(false); }
  }

  return <div className="pt-2">
    {routine && <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-line-1 pb-4"><button disabled={pending} onClick={() => void toggle()} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs disabled:opacity-50">{routine.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}{routine.enabled ? "Pause" : "Resume"}</button><button disabled={pending || running} onClick={() => void runNow()} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-accent px-3 text-label font-title text-ink-on-accent disabled:opacity-50">{running ? <LoaderCircle className="size-3.5 animate-spin" /> : needsRetry ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}{running ? "Running…" : needsRetry ? "Retry now" : "Test run"}</button><button disabled={pending} onClick={() => void remove()} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-label text-danger hover:bg-danger-soft disabled:opacity-50"><Trash2 className="size-3.5" />Delete</button></div>}
    {routine !== null && routine.lastMissedAt !== null && <div className="mb-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-label text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>Vivid was offline for the expected run at {formatTime(routine.lastMissedAt)}. It was not silently replayed. Retry it when ready.</p></div>}
    <form onSubmit={(event) => void save(event)} className="space-y-4">
      <label className="block"><span className="mb-1.5 block text-label font-title text-ink-2">Name</span><input required maxLength={120} value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Daily project brief" className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs outline-none focus:shadow-ring-sm" /></label>
      <label className="block"><span className="mb-1.5 block text-label font-title text-ink-2">Instruction</span><textarea required maxLength={4000} rows={5} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} placeholder="Review recent project activity and prepare a concise brief." className="w-full resize-y rounded-control bg-surface-2 px-3 py-2.5 text-label text-ink shadow-ring-xs outline-none focus:shadow-ring-sm" /></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-label font-title text-ink-2">When to run</span><select value={cron} onChange={(event) => setCron(event.currentTarget.value)} className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs"><option value="0 * * * *">Every hour</option><option value="0 9 * * *">Every day at 9:00 AM</option><option value="0 9 * * 1-5">Weekdays at 9:00 AM</option><option value="0 9 * * 1">Mondays at 9:00 AM</option></select></label><label className="block"><span className="mb-1.5 block text-label font-title text-ink-2">Timezone</span><input required value={timezone} onChange={(event) => setTimezone(event.currentTarget.value)} className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs" /></label></div>
      <label className="block"><span className="mb-1.5 block text-meta font-meta text-ink-4">Advanced cron expression</span><input required value={cron} onChange={(event) => setCron(event.currentTarget.value)} className="h-9 w-full rounded-control bg-surface-2 px-3 font-mono text-meta text-ink shadow-ring-xs" /></label>
      {error && <p className="text-label text-danger" role="alert">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1"><button type="button" onClick={onCancel} className="h-9 rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover">Cancel</button><button disabled={pending} className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent disabled:opacity-50">{pending && <LoaderCircle className="size-3.5 animate-spin" />}{routine ? "Save changes" : "Create routine"}</button></div>
    </form>
    {routine && <div className="mt-7 border-t border-line-1 pt-4"><h2 className="text-label font-title text-ink-2">Run history</h2>{routine.runs.length === 0 ? <p className="mt-2 text-label text-ink-4">No runs yet.</p> : <ul className="mt-2 space-y-1">{routine.runs.map((run) => <li key={run.id}><button type="button" title="Open conversation" onClick={() => onOpenConversation({ id: run.conversationId, title: routine.name, preview: plainPreview(run.output ?? run.error ?? routine.prompt), updatedAt: run.finishedAt ?? run.startedAt, archived: false })} className="group/run w-full rounded-row bg-surface-2 px-3 py-2.5 text-left shadow-ring-xs transition-[background-color,box-shadow] hover:bg-wash-hover hover:shadow-ring-sm"><div className="flex items-center gap-2"><span className={cn("size-2 rounded-full", run.status === "succeeded" ? "bg-success" : run.status === "failed" ? "bg-danger" : "animate-pulse bg-working")} /><span className="text-label text-ink capitalize">{run.status}</span><time className="ml-auto text-meta font-meta text-ink-4">{formatTime(run.startedAt)}</time><ChevronRight className="size-3.5 text-ink-4 transition-transform group-hover/run:translate-x-0.5" /></div>{run.output && <p className="mt-1 line-clamp-3 text-meta whitespace-pre-wrap text-ink-3">{run.output}</p>}{run.error && <p className="mt-1 text-meta text-danger">{run.error}</p>}</button></li>)}</ul>}</div>}
  </div>;
}

function TemplateCard({ template: item, onOpen }: { template: RoutineTemplate; onOpen: () => void }) {
  return <button onClick={onOpen} className="group/card flex h-full flex-col rounded-card bg-surface-2 p-4 text-left shadow-ring-xs transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-wash-hover hover:shadow-ring-sm"><span className="flex h-6 items-center gap-2"><span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-meta font-title", brandText[item.brandColor])}>{item.publisher}</span><span className="flex-1" /><span className="text-meta font-title text-ink">{item.price}</span></span><span className="mt-2.5 block text-title text-ink">{item.name}</span><span className="mt-0.5 line-clamp-2 text-label text-ink-3">{item.summary}</span><span className="mt-auto flex items-center gap-2 pt-3 text-meta font-meta text-ink-4"><Star className="size-3.5 fill-current text-approve" />{item.rating}<span>·</span>{item.installs} using it<ChevronRight className="ml-auto size-3.5 transition-transform duration-(--dur-fast) group-hover/card:translate-x-0.5" /></span></button>;
}

function TemplateDetail({ template: item }: { template: RoutineTemplate }) {
  return <div className="pt-2"><div className="flex items-start gap-3"><span className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-control", brandText[item.brandColor])}><Repeat2 className="size-6" strokeWidth={1.7} /></span><div className="min-w-0 flex-1"><h2 className="text-page font-title text-ink">{item.name}</h2><p className="text-label text-ink-3">{item.summary}</p><p className="mt-1 text-meta font-meta text-ink-4">by {item.publisher} · {item.installs} using it · ★ {item.rating}</p></div><div className="text-right"><p className="text-title font-title text-ink">{item.price}</p></div></div><div className="mt-6 border-t border-line-1 pt-4"><h3 className="text-label font-title text-ink-2">What it does</h3><p className="mt-1 px-0.5 text-meta font-meta text-ink-4">{item.trigger}</p><ol className="mt-2 flex flex-col gap-2">{item.actions.map((action, index) => <li key={action} className="flex items-center gap-3 rounded-row bg-surface-2 px-3 py-2.5 shadow-ring-xs"><span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-meta font-meta text-ink-2">{index + 1}</span><span className="min-w-0 flex-1 text-label text-ink">{action}</span>{index === item.actions.length - 1 && <Check className="size-4 shrink-0 text-success" />}</li>)}</ol></div><div className="mt-5 flex items-start gap-3 rounded-card bg-surface-2 p-4 shadow-ring-xs"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" /><p className="text-meta text-ink-3">Runs inside your Vivid. The template supplies instructions, not access to your data.</p></div></div>;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <div className="mt-7"><div className="mb-1 flex items-baseline gap-2.5 border-t border-line-1 px-0.5 pt-4"><h2 className="text-label font-title text-ink-2">{title}</h2>{note && <p className="truncate text-meta font-meta text-ink-4">{note}</p>}</div>{children}</div>;
}
