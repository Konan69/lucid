import {
  AlertTriangle, BellRing, Check, ChevronRight, Circle, CircleCheck, Clock3, LoaderCircle,
  MessageSquareText, Plus, Repeat2, RotateCcw, Trash2, UserRound, X,
} from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { cn } from "../ui/cn";
import { Face } from "../ui/Face";

export type TaskStatus = "open" | "done" | "dropped";
export type TaskPriority = "normal" | "urgent";

export type FollowUp = {
  id: string;
  taskId: string;
  at: number;
  note: string;
  repeatEveryMs: number | null;
  status: "scheduled" | "running" | "fired" | "cancelled" | "failed";
  firedAt: number | null;
  output: string | null;
  error: string | null;
  createdBy: "you" | "vivid";
  createdAt: number;
};

export type Task = {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  dueAt: number | null;
  origin: { kind: "conversation"; conversationId: string } | { kind: "routine"; routineId: string } | { kind: "manual" };
  createdBy: "you" | "vivid";
  conversationId: string;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  followUps: FollowUp[];
  nextFollowUpAt: number | null;
};

export type Notification = {
  id: string;
  kind: "tracked" | "overdue" | "follow-up" | "follow-up-failed";
  title: string;
  body: string;
  taskId: string | null;
  conversationId: string | null;
  createdAt: number;
  readAt: number | null;
};

const DAY_MS = 86_400_000;
const CURRENT_TIME_REFRESH_MS = 15_000;
const currentTimeListeners = new Set<() => void>();
let currentTime = Date.now();
let currentTimeTimer: number | null = null;

/**
 * Keeps render-time date comparisons on one stable snapshot while the Today screen is mounted.
 * The shared timer matches the screen's idle refresh cadence and is released with the last row.
 */
function subscribeCurrentTime(listener: () => void) {
  currentTimeListeners.add(listener);
  if (currentTimeTimer === null) {
    const update = () => {
      currentTime = Date.now();
      for (const currentListener of currentTimeListeners) currentListener();
    };
    update();
    currentTimeTimer = window.setInterval(update, CURRENT_TIME_REFRESH_MS);
  }
  return () => {
    currentTimeListeners.delete(listener);
    if (currentTimeListeners.size === 0 && currentTimeTimer !== null) {
      window.clearInterval(currentTimeTimer);
      currentTimeTimer = null;
    }
  };
}

function getCurrentTime() {
  return currentTime;
}

function useCurrentTime() {
  return useSyncExternalStore(subscribeCurrentTime, getCurrentTime, getCurrentTime);
}

const REPEAT_OPTIONS = [
  { label: "Once", value: "" },
  { label: "Every day", value: String(DAY_MS) },
  { label: "Every week", value: String(7 * DAY_MS) },
] as const;

const NOTIFICATION_TONE = {
  tracked: "bg-accent",
  overdue: "bg-danger",
  "follow-up": "bg-working",
  "follow-up-failed": "bg-danger",
} satisfies Record<Notification["kind"], string>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function startOfDay(value: number) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today 14:30", "Tomorrow 09:00", "Fri 5 Sep, 09:00". Dates matter here, so we never say "2h ago". */
export function formatWhen(value: number, withTime = true) {
  const days = Math.round((startOfDay(value) - startOfDay(Date.now())) / DAY_MS);
  const time = withTime ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value) : "";
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday"
    : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(value);
  return withTime ? `${day} ${time}`.trim() : day;
}

function toLocalInput(value: number | null) {
  if (value === null) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function describeRepeat(repeatEveryMs: number | null) {
  if (!repeatEveryMs) return null;
  if (repeatEveryMs === DAY_MS) return "every day";
  if (repeatEveryMs === 7 * DAY_MS) return "every week";
  return `every ${Math.round(repeatEveryMs / 3_600_000)}h`;
}

type Group = { key: string; label: string; note?: string; tasks: Task[] };

function groupTasks(tasks: Task[], now: number): Group[] {
  const endOfToday = startOfDay(now) + DAY_MS;
  const open = tasks.filter((task) => task.status === "open");
  const taken = new Set<string>();
  const pick = (key: string, label: string, note: string | undefined, test: (task: Task) => boolean): Group => {
    const picked = open.filter((task) => !taken.has(task.id) && test(task));
    for (const task of picked) taken.add(task.id);
    return { key, label, note, tasks: picked };
  };
  return [
    pick("overdue", "Overdue", "Vivid has already started chasing these.", (task) => task.dueAt !== null && task.dueAt < now),
    pick("today", "Due today", undefined, (task) => task.dueAt !== null && task.dueAt < endOfToday),
    pick("waiting", "Waiting on others", "Vivid drafts the nudge; you send it.", (task) => task.assignee !== null),
    pick("upcoming", "Vivid follows up", undefined, (task) => task.nextFollowUpAt !== null),
    pick("later", "Later", undefined, () => true),
  ].filter((group) => group.tasks.length > 0);
}

export function Today({ onOpenConversation }: { onOpenConversation(conversationId: string, fallbackTitle: string): void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [taskBody, notificationBody] = await Promise.all([
        request<{ tasks: Task[] }>("/api/tasks"),
        request<{ notifications: Notification[] }>("/api/notifications"),
      ]);
      setTasks(taskBody.tasks);
      setNotifications(notificationBody.notifications);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load today");
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Initial hydration is an external request. Polling and user-triggered refreshes continue to
    // use `load`, while this mount request ignores responses after the screen is removed.
    void Promise.all([
      request<{ tasks: Task[] }>("/api/tasks"),
      request<{ notifications: Notification[] }>("/api/notifications"),
    ]).then(([taskBody, notificationBody]) => {
      if (cancelled) return;
      setTasks(taskBody.tasks);
      setNotifications(notificationBody.notifications);
      setError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load today");
    }).finally(() => {
      if (!cancelled) setReady(true);
    });

    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const running = tasks.some((task) => task.followUps.some((followUp) => followUp.status === "running"));
    const timer = window.setInterval(() => { void load(); }, running ? 1500 : 15_000);
    return () => window.clearInterval(timer);
  }, [load, tasks]);

  const now = useCurrentTime();
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const unread = notifications.filter((notification) => notification.readAt === null);
  const groups = groupTasks(tasks, now);
  const settled = tasks.filter((task) => task.status !== "open").slice(0, 12);
  const inDetail = selected !== null || creating;
  const back = () => { setSelectedId(null); setCreating(false); };

  async function toggleDone(task: Task) {
    try {
      await request(`/api/tasks/${task.id}`, json("PATCH", { status: task.status === "open" ? "done" : "open" }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the task");
    }
  }

  async function markAllRead() {
    try {
      await request("/api/notifications/read", json("POST", {}));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark notifications read");
    }
  }

  async function openNotification(notification: Notification) {
    if (notification.readAt === null) {
      void request("/api/notifications/read", json("POST", { ids: [notification.id] })).then(load).catch(() => undefined);
    }
    if (notification.taskId && tasks.some((task) => task.id === notification.taskId)) setSelectedId(notification.taskId);
    else if (notification.conversationId) onOpenConversation(notification.conversationId, notification.title);
  }

  const today = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(now);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        {inDetail && <button onClick={back} aria-label="Back to today" className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><ChevronRight className="size-4 rotate-180" /></button>}
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{selected?.title ?? (creating ? "New task" : "Today")}</h1>
        {!inDetail && <button aria-label="New task" onClick={() => setCreating(true)} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><Plus className="size-4" /></button>}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-[920px] px-5 pb-10 pt-1 sm:px-8">
          {error && <div className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger" role="alert">{error}</div>}
          {selected || creating ? (
            <TaskDetail
              task={selected}
              onOpenConversation={onOpenConversation}
              onCancel={back}
              onChanged={async (id) => { await load(); setCreating(false); setSelectedId(id); }}
              onDeleted={async () => { back(); await load(); }}
            />
          ) : (
            <>
              <p className="px-0.5 text-meta font-meta text-ink-4">{today}</p>

              {unread.length > 0 && (
                <Section title="Needs you" note={`${unread.length} new`} action={<button onClick={() => void markAllRead()} className="text-meta font-title text-ink-3 hover:text-ink">Mark all read</button>}>
                  <ul className="flex flex-col gap-1">
                    {unread.map((notification) => (
                      <li key={notification.id}>
                        <button onClick={() => void openNotification(notification)} className="group/row flex w-full items-start gap-3 rounded-row bg-surface-2 px-3 py-2.5 text-left shadow-ring-xs transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-wash-hover hover:shadow-ring-sm">
                          <i className={cn("mt-[7px] size-2 shrink-0 rounded-full", NOTIFICATION_TONE[notification.kind])} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-label font-title text-ink">{notification.title}</span>
                            {notification.body && <span className="mt-0.5 line-clamp-2 block text-label text-ink-3">{notification.body}</span>}
                          </span>
                          <time className="shrink-0 pt-0.5 text-meta font-meta tabular-nums text-ink-4">{formatWhen(notification.createdAt)}</time>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {!ready ? (
                <div className="flex items-center gap-2 px-2.5 py-8 text-label text-ink-4"><LoaderCircle className="size-4 animate-spin" />Loading…</div>
              ) : groups.length === 0 && unread.length === 0 ? (
                <div className="mt-7 rounded-card bg-surface-2 px-6 py-10 text-center shadow-ring-xs">
                  <Face size={32} mood="happy" className="mx-auto" />
                  <p className="mt-3 text-title font-title text-ink">Nothing needs you.</p>
                  <p className="mx-auto mt-1 max-w-sm text-label text-ink-3">Ask Vivid to remind you, chase someone, or check on something later, and it lands here. Or add a task yourself.</p>
                  <button onClick={() => setCreating(true)} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-3 px-3 text-label font-title text-ink shadow-ring-xs hover:bg-wash-hover"><Plus className="size-3.5" />New task</button>
                </div>
              ) : (
                groups.map((group) => (
                  <Section key={group.key} title={group.label} note={group.note}>
                    <ul className="flex flex-col gap-px">
                      {group.tasks.map((task) => <li key={task.id}><TaskRow task={task} onOpen={() => setSelectedId(task.id)} onToggle={() => void toggleDone(task)} /></li>)}
                    </ul>
                  </Section>
                ))
              )}

              {ready && groups.length > 0 && (
                <button onClick={() => setCreating(true)} className="mt-2 flex w-full items-center gap-2.5 rounded-row px-2.5 py-2.5 text-left text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"><span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2"><Plus className="size-4" /></span><span className="text-title">New task</span></button>
              )}

              {settled.length > 0 && (
                <div className="mt-6">
                  <button onClick={() => setDoneOpen((open) => !open)} className="flex h-(--caption-h) items-center gap-1.5 px-0.5 text-meta font-title text-ink-4 hover:text-ink-2">
                    <Check className="size-3.5" />Done <span className="font-meta">{tasks.filter((task) => task.status !== "open").length}</span>
                  </button>
                  {doneOpen && <ul className="mt-1 flex flex-col gap-px">{settled.map((task) => <li key={task.id}><TaskRow task={task} onOpen={() => setSelectedId(task.id)} onToggle={() => void toggleDone(task)} /></li>)}</ul>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function TaskRow({ task, onOpen, onToggle }: { task: Task; onOpen(): void; onToggle(): void }) {
  const now = useCurrentTime();
  const overdue = task.status === "open" && task.dueAt !== null && task.dueAt < now;
  const running = task.followUps.some((followUp) => followUp.status === "running");
  const settled = task.status !== "open";
  const meta = [
    task.assignee ? `Waiting on ${task.assignee}` : null,
    task.dueAt !== null ? (settled ? null : overdue ? `Was due ${formatWhen(task.dueAt, false)}` : `Due ${formatWhen(task.dueAt, false)}`) : null,
    task.status === "done" && task.completedAt ? `Done ${formatWhen(task.completedAt, false)}` : task.status === "dropped" ? "Dropped" : null,
  ].filter(Boolean);
  return (
    <div className={cn("group/row flex items-center gap-2.5 rounded-row px-2.5 py-2 transition-colors duration-(--dur-fast) hover:bg-wash-hover", settled && "opacity-70 hover:opacity-100")}>
      <button onClick={onToggle} aria-label={settled ? "Reopen" : "Mark done"} className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 hover:text-success">
        {task.status === "done" ? <CircleCheck className="size-[18px] text-success" /> : task.status === "dropped" ? <X className="size-4" /> : <Circle className="size-[18px]" strokeWidth={1.6} />}
      </button>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-title", settled ? "text-ink-3 line-through decoration-line-4" : "text-ink")}>{task.title}</span>
          <span className={cn("mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-meta font-meta", overdue ? "text-danger" : "text-ink-4")}>
            {meta.length > 0 && <span className="truncate">{meta.join(" · ")}</span>}
            {task.status === "open" && task.nextFollowUpAt !== null && (
              <span className={cn("inline-flex shrink-0 items-center gap-1 text-ink-4", meta.length > 0 && "before:mr-0.5 before:content-['·']")}>
                {running ? <LoaderCircle className="size-3 animate-spin text-working" /> : <Face size={12} />}
                {running ? "Vivid is on it" : `Vivid follows up ${formatWhen(task.nextFollowUpAt)}`}
              </span>
            )}
          </span>
        </span>
        {task.priority === "urgent" && task.status === "open" && <span className="shrink-0 rounded-full bg-approve-soft px-2 py-0.5 text-meta font-title text-approve">Urgent</span>}
        <ChevronRight className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/row:opacity-100" />
      </button>
    </div>
  );
}

function TaskDetail({ task, onChanged, onDeleted, onCancel, onOpenConversation }: { task: Task | null; onChanged(id: string): Promise<void>; onDeleted(): Promise<void>; onCancel(): void; onOpenConversation(conversationId: string, fallbackTitle: string): void }) {
  const now = useCurrentTime();
  const [title, setTitle] = useState(task?.title ?? "");
  const [detail, setDetail] = useState(task?.detail ?? "");
  const [assignee, setAssignee] = useState(task?.assignee ?? "");
  const [dueAt, setDueAt] = useState(toLocalInput(task?.dueAt ?? null));
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "normal");
  const [followUpAt, setFollowUpAt] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [repeat, setRepeat] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chasing = task?.followUps.some((followUp) => followUp.status === "running") ?? false;
  const dirty = task ? title !== task.title || detail !== task.detail || (assignee.trim() || null) !== task.assignee || fromLocalInput(dueAt) !== task.dueAt || priority !== task.priority : true;

  async function run<T>(work: () => Promise<T>, fallback: string) {
    setPending(true);
    setError(null);
    try { return await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : fallback); return undefined; }
    finally { setPending(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const payload = { title: title.trim(), detail: detail.trim(), assignee: assignee.trim() || null, dueAt: fromLocalInput(dueAt), priority };
    const body = await run(() => request<{ task: Task }>(task ? `/api/tasks/${task.id}` : "/api/tasks", json(task ? "PATCH" : "POST", task ? payload : { ...payload, followUp: fromLocalInput(followUpAt) ? { at: fromLocalInput(followUpAt), note: followUpNote.trim(), repeatEveryMs: repeat ? Number(repeat) : null } : undefined })), "Could not save the task");
    if (body) await onChanged(body.task.id);
  }

  async function setStatus(status: TaskStatus) {
    if (!task) return;
    if (await run(() => request(`/api/tasks/${task.id}`, json("PATCH", { status })), "Could not update the task")) await onChanged(task.id);
  }

  async function chaseNow() {
    if (!task) return;
    if (await run(() => request(`/api/tasks/${task.id}/nudge`, json("POST", {})), "Could not start the chase")) await onChanged(task.id);
  }

  async function remove() {
    if (!task || !window.confirm(`Delete “${task.title}”? Its follow-ups go with it.`)) return;
    if (await run(() => request(`/api/tasks/${task.id}`, { method: "DELETE" }), "Could not delete the task")) await onDeleted();
  }

  async function addFollowUp(event: FormEvent) {
    event.preventDefault();
    if (!task) return;
    const at = fromLocalInput(followUpAt);
    if (at === null) { setError("Pick a time for the follow-up"); return; }
    if (await run(() => request(`/api/tasks/${task.id}/follow-ups`, json("POST", { at, note: followUpNote.trim(), repeatEveryMs: repeat ? Number(repeat) : null })), "Could not schedule the follow-up")) {
      setFollowUpAt(""); setFollowUpNote(""); setRepeat("");
      await onChanged(task.id);
    }
  }

  async function followUpAction(followUp: FollowUp, action: "run" | "cancel" | "delete") {
    if (!task) return;
    const work = action === "run"
      ? () => request(`/api/follow-ups/${followUp.id}/run`, { method: "POST" })
      : action === "cancel"
        ? () => request(`/api/follow-ups/${followUp.id}`, json("PATCH", { status: "cancelled" }))
        : () => request(`/api/follow-ups/${followUp.id}`, { method: "DELETE" });
    if (await run(work, "Could not update the follow-up")) await onChanged(task.id);
  }

  const quickTimes: Array<{ label: string; at: () => number }> = [
    { label: "Tomorrow 9:00", at: () => startOfDay(Date.now()) + DAY_MS + 9 * 3_600_000 },
    { label: "In 3 days", at: () => startOfDay(Date.now()) + 3 * DAY_MS + 9 * 3_600_000 },
    { label: "Next Monday", at: () => { const day = new Date(startOfDay(Date.now())); const delta = ((8 - day.getDay()) % 7) || 7; return day.getTime() + delta * DAY_MS + 9 * 3_600_000; } },
  ];

  const fieldClass = "h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs outline-none focus:shadow-ring-sm";
  const labelClass = "mb-1.5 block text-label font-title text-ink-2";

  return (
    <div className="pt-2">
      {task && (
        <div className="mb-5 flex flex-wrap items-center gap-2 border-b border-line-1 pb-4">
          {task.status === "open" ? (
            <button disabled={pending} onClick={() => void setStatus("done")} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs disabled:opacity-50"><Check className="size-3.5" />Mark done</button>
          ) : (
            <button disabled={pending} onClick={() => void setStatus("open")} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs disabled:opacity-50"><RotateCcw className="size-3.5" />Reopen</button>
          )}
          {task.status === "open" && (
            <button disabled={pending || chasing} onClick={() => void chaseNow()} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-accent px-3 text-label font-title text-ink-on-accent disabled:opacity-50">
              {chasing ? <LoaderCircle className="size-3.5 animate-spin" /> : <BellRing className="size-3.5" />}{chasing ? "Vivid is on it…" : task.assignee ? `Chase ${task.assignee} now` : "Remind me now"}
            </button>
          )}
          {task.status === "open" && task.followUps.some((followUp) => followUp.status === "fired") && (
            <button onClick={() => onOpenConversation(task.conversationId, task.title)} className="inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-label text-ink-2 hover:bg-wash-hover hover:text-ink"><MessageSquareText className="size-3.5" />Open conversation</button>
          )}
          <button disabled={pending} onClick={() => void remove()} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-label text-danger hover:bg-danger-soft disabled:opacity-50"><Trash2 className="size-3.5" />Delete</button>
        </div>
      )}

      {task && task.status === "open" && task.dueAt !== null && task.dueAt < now && (
        <div className="mb-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-label text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>Past due since {formatWhen(task.dueAt)}. Vivid chased it once automatically; chase again, move the date, or close it.</p></div>
      )}

      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <label className="block"><span className={labelClass}>What</span><input autoFocus={!task} required maxLength={200} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Get the signed contract back from Dami" className={fieldClass} /></label>
        <label className="block"><span className={labelClass}>Detail <span className="font-meta text-ink-4">optional</span></span><textarea maxLength={2000} rows={3} value={detail} onChange={(event) => setDetail(event.currentTarget.value)} placeholder="Anything Vivid should know when it follows up." className="w-full resize-y rounded-control bg-surface-2 px-3 py-2.5 text-label text-ink shadow-ring-xs outline-none focus:shadow-ring-sm" /></label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block"><span className={labelClass}>Waiting on</span><span className="relative block"><UserRound className="pointer-events-none absolute left-3 top-3 size-4 text-ink-4" /><input maxLength={80} value={assignee} onChange={(event) => setAssignee(event.currentTarget.value)} placeholder="You" className={cn(fieldClass, "pl-9")} /></span></label>
          <label className="block"><span className={labelClass}>Due</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} className={fieldClass} /></label>
          <label className="block"><span className={labelClass}>Priority</span><select value={priority} onChange={(event) => setPriority(event.currentTarget.value as TaskPriority)} className={fieldClass}><option value="normal">Normal</option><option value="urgent">Urgent</option></select></label>
        </div>

        {!task && (
          <div className="rounded-card bg-surface-2 p-4 shadow-ring-xs">
            <div className="flex items-center gap-2 text-label font-title text-ink-2"><Face size={16} />First follow-up <span className="font-meta text-ink-4">optional</span></div>
            <FollowUpFields at={followUpAt} note={followUpNote} repeat={repeat} onAt={setFollowUpAt} onNote={setFollowUpNote} onRepeat={setRepeat} quickTimes={quickTimes} />
          </div>
        )}

        {error && <p className="text-label text-danger" role="alert">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className="h-9 rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover">{task ? "Back" : "Cancel"}</button>
          <button disabled={pending || !dirty || !title.trim()} className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent disabled:opacity-50">{pending && <LoaderCircle className="size-3.5 animate-spin" />}{task ? "Save changes" : "Add task"}</button>
        </div>
      </form>

      {task && (
        <div className="mt-7 border-t border-line-1 pt-4">
          <div className="flex items-baseline gap-2.5"><h2 className="text-label font-title text-ink-2">Follow-ups</h2><p className="text-meta font-meta text-ink-4">When Vivid wakes up and acts on this.</p></div>
          {task.followUps.length === 0 ? <p className="mt-2 text-label text-ink-4">None yet.</p> : (
            <ul className="mt-2 space-y-1">
              {task.followUps.map((followUp) => <li key={followUp.id}><FollowUpRow followUp={followUp} onAction={(action) => void followUpAction(followUp, action)} onOpen={() => onOpenConversation(task.conversationId, task.title)} /></li>)}
            </ul>
          )}
          {task.status === "open" && (
            <form onSubmit={(event) => void addFollowUp(event)} className="mt-3 rounded-card bg-surface-2 p-4 shadow-ring-xs">
              <div className="flex items-center gap-2 text-label font-title text-ink-2"><Plus className="size-3.5" />Add a follow-up</div>
              <FollowUpFields at={followUpAt} note={followUpNote} repeat={repeat} onAt={setFollowUpAt} onNote={setFollowUpNote} onRepeat={setRepeat} quickTimes={quickTimes} />
              <div className="mt-3 flex justify-end"><button disabled={pending || !followUpAt} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-surface-3 px-3 text-label font-title text-ink shadow-ring-xs disabled:opacity-50 hover:bg-wash-hover"><Clock3 className="size-3.5" />Schedule</button></div>
            </form>
          )}
        </div>
      )}

      {task && task.origin.kind !== "manual" && (
        <p className="mt-5 text-meta font-meta text-ink-4">
          {task.createdBy === "vivid" ? "Vivid started tracking this" : "Added"} {formatWhen(task.createdAt)}
          {task.origin.kind === "conversation" && <> · <button onClick={() => onOpenConversation(task.origin.kind === "conversation" ? task.origin.conversationId : task.conversationId, task.title)} className="text-ink-3 underline underline-offset-2 hover:text-ink">from a conversation</button></>}
          {task.origin.kind === "routine" && " · from a routine"}
        </p>
      )}
    </div>
  );
}

function FollowUpFields({ at, note, repeat, onAt, onNote, onRepeat, quickTimes }: { at: string; note: string; repeat: string; onAt(value: string): void; onNote(value: string): void; onRepeat(value: string): void; quickTimes: Array<{ label: string; at: () => number }> }) {
  const fieldClass = "h-9 w-full rounded-control bg-surface-3 px-3 text-label text-ink shadow-ring-xs outline-none focus:shadow-ring-sm";
  return (
    <div className="mt-3 space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {quickTimes.map((quick) => <button key={quick.label} type="button" onClick={() => onAt(toLocalInput(quick.at()))} className="h-7 rounded-full bg-surface-3 px-2.5 text-meta font-title text-ink-2 shadow-ring-xs hover:bg-wash-hover hover:text-ink">{quick.label}</button>)}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input type="datetime-local" aria-label="When" value={at} onChange={(event) => onAt(event.currentTarget.value)} className={fieldClass} />
        <input maxLength={500} value={note} onChange={(event) => onNote(event.currentTarget.value)} placeholder="What to check or say" className={fieldClass} />
        <select aria-label="Repeat" value={repeat} onChange={(event) => onRepeat(event.currentTarget.value)} className={cn(fieldClass, "w-auto")}>{REPEAT_OPTIONS.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}</select>
      </div>
    </div>
  );
}

function FollowUpRow({ followUp, onAction, onOpen }: { followUp: FollowUp; onAction(action: "run" | "cancel" | "delete"): void; onOpen(): void }) {
  const tone = followUp.status === "scheduled" ? "bg-accent" : followUp.status === "running" ? "animate-status-pulse bg-working" : followUp.status === "fired" ? "bg-success" : followUp.status === "failed" ? "bg-danger" : "bg-ink-4";
  const label = followUp.status === "scheduled" ? "Scheduled" : followUp.status === "running" ? "Vivid is on it" : followUp.status === "fired" ? "Followed up" : followUp.status === "failed" ? "Failed" : "Cancelled";
  const repeat = describeRepeat(followUp.repeatEveryMs);
  return (
    <div className={cn("rounded-row bg-surface-2 px-3 py-2.5 shadow-ring-xs", followUp.status === "cancelled" && "opacity-60")}>
      <div className="flex items-center gap-2">
        <i className={cn("size-2 shrink-0 rounded-full", tone)} aria-hidden />
        <span className="text-label text-ink">{label}</span>
        <time className="text-meta font-meta tabular-nums text-ink-4">{formatWhen(followUp.firedAt ?? followUp.at)}</time>
        {repeat && <span className="inline-flex items-center gap-1 text-meta font-meta text-ink-4"><Repeat2 className="size-3" />{repeat}</span>}
        {followUp.createdBy === "vivid" && <span className="text-meta font-meta text-ink-4">· by Vivid</span>}
        <span className="ml-auto flex items-center gap-1">
          {followUp.status === "scheduled" && <>
            <button onClick={() => onAction("run")} className="h-7 rounded-control px-2 text-meta font-title text-ink-2 hover:bg-wash-hover hover:text-ink">Run now</button>
            <button onClick={() => onAction("cancel")} className="h-7 rounded-control px-2 text-meta font-title text-ink-3 hover:bg-wash-hover hover:text-ink">Cancel</button>
          </>}
          {(followUp.status === "fired" || followUp.status === "failed") && <button onClick={onOpen} className="inline-flex h-7 items-center gap-1 rounded-control px-2 text-meta font-title text-ink-2 hover:bg-wash-hover hover:text-ink"><MessageSquareText className="size-3" />Open</button>}
          {(followUp.status === "cancelled" || followUp.status === "failed") && <button onClick={() => onAction("delete")} aria-label="Remove follow-up" className="inline-flex size-7 items-center justify-center rounded-control text-ink-4 hover:bg-danger-soft hover:text-danger"><Trash2 className="size-3" /></button>}
        </span>
      </div>
      {followUp.note && <p className="mt-1 text-meta text-ink-3">{followUp.note}</p>}
      {followUp.output && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-label text-ink-2">{followUp.output}</p>}
      {followUp.error && <p className="mt-1 text-meta text-danger">{followUp.error}</p>}
    </div>
  );
}

function Section({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div className="mb-1 flex items-baseline gap-2.5 border-t border-line-1 px-0.5 pt-4">
        <h2 className="text-label font-title text-ink-2">{title}</h2>
        {note && <p className="truncate text-meta font-meta text-ink-4">{note}</p>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  );
}
