import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";

export type TaskStatus = "open" | "done" | "dropped";
export type TaskPriority = "normal" | "urgent";
export type Author = "you" | "vivid";
export type TaskOrigin =
  | { kind: "conversation"; conversationId: string }
  | { kind: "routine"; routineId: string }
  | { kind: "manual" };

export type Task = {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** `null` means the task is yours. Otherwise the name of the person the work waits on. */
  assignee: string | null;
  dueAt: number | null;
  origin: TaskOrigin;
  createdBy: Author;
  /** The conversation where Vivid follows up on this task. */
  conversationId: string;
  overdueNotifiedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type FollowUpStatus = "scheduled" | "running" | "fired" | "cancelled" | "failed";

export type FollowUp = {
  id: string;
  taskId: string;
  at: number;
  note: string;
  repeatEveryMs: number | null;
  status: FollowUpStatus;
  submissionId: string | null;
  firedAt: number | null;
  output: string | null;
  error: string | null;
  createdBy: Author;
  createdAt: number;
};

export type NotificationKind = "tracked" | "overdue" | "follow-up" | "follow-up-failed";

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  taskId: string | null;
  conversationId: string | null;
  createdAt: number;
  readAt: number | null;
};

export type TaskView = Task & { followUps: FollowUp[]; nextFollowUpAt: number | null };

export const TASK_STATUSES: readonly TaskStatus[] = ["open", "done", "dropped"];
export const TASK_PRIORITIES: readonly TaskPriority[] = ["normal", "urgent"];

const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS konan_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee TEXT,
    due_at INTEGER,
    origin_kind TEXT NOT NULL,
    origin_id TEXT,
    created_by TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    overdue_notified_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS konan_tasks_status_due ON konan_tasks(status, due_at);
  CREATE TABLE IF NOT EXISTS konan_follow_ups (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES konan_tasks(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    repeat_every_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'scheduled',
    submission_id TEXT,
    fired_at INTEGER,
    output TEXT,
    error TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS konan_follow_ups_status_at ON konan_follow_ups(status, at);
  CREATE TABLE IF NOT EXISTS konan_notifications (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    task_id TEXT,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS konan_notifications_created ON konan_notifications(created_at DESC);
`);

const followUpTableColumns = database.prepare("PRAGMA table_info(konan_follow_ups)").all() as unknown as Array<{ name: string }>;
if (!followUpTableColumns.some((column) => column.name === "submission_id")) {
  database.exec("ALTER TABLE konan_follow_ups ADD COLUMN submission_id TEXT");
}

const taskColumns = `
  id, title, detail, status, priority, assignee, due_at AS dueAt,
  origin_kind AS originKind, origin_id AS originId, created_by AS createdBy,
  conversation_id AS conversationId, overdue_notified_at AS overdueNotifiedAt,
  completed_at AS completedAt, created_at AS createdAt, updated_at AS updatedAt
`;

type TaskRow = Omit<Task, "origin"> & { originKind: TaskOrigin["kind"]; originId: string | null };

function mapTask(row: unknown): Task {
  const { originKind, originId, ...value } = row as TaskRow;
  const origin: TaskOrigin = originKind === "conversation" && originId
    ? { kind: "conversation", conversationId: originId }
    : originKind === "routine" && originId
      ? { kind: "routine", routineId: originId }
      : { kind: "manual" };
  return { ...value, origin };
}

export function listTasks(status?: TaskStatus): Task[] {
  const rows = status
    ? database.prepare(`SELECT ${taskColumns} FROM konan_tasks WHERE status = ? ORDER BY due_at IS NULL, due_at ASC, created_at DESC`).all(status)
    : database.prepare(`SELECT ${taskColumns} FROM konan_tasks ORDER BY status = 'open' DESC, due_at IS NULL, due_at ASC, created_at DESC`).all();
  return (rows as unknown[]).map(mapTask);
}

export function getTask(id: string): Task | null {
  const row = database.prepare(`SELECT ${taskColumns} FROM konan_tasks WHERE id = ?`).get(id);
  return row ? mapTask(row) : null;
}

export function createTask(input: {
  id?: string;
  title: string;
  detail?: string;
  assignee?: string | null;
  dueAt?: number | null;
  priority?: TaskPriority;
  origin: TaskOrigin;
  createdBy: Author;
}): Task {
  const now = Date.now();
  const id = input.id ?? randomUUID();
  const task: Task = {
    id,
    title: input.title,
    detail: input.detail ?? "",
    status: "open",
    priority: input.priority ?? "normal",
    assignee: input.assignee ?? null,
    dueAt: input.dueAt ?? null,
    origin: input.origin,
    createdBy: input.createdBy,
    conversationId: `task-${id}`,
    overdueNotifiedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const originId = task.origin.kind === "conversation" ? task.origin.conversationId : task.origin.kind === "routine" ? task.origin.routineId : null;
  database.prepare(`
    INSERT OR IGNORE INTO konan_tasks
      (id, title, detail, status, priority, assignee, due_at, origin_kind, origin_id, created_by, conversation_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task.id, task.title, task.detail, task.status, task.priority, task.assignee, task.dueAt, task.origin.kind, originId, task.createdBy, task.conversationId, now, now);
  return getTask(id) ?? task;
}

export type TaskPatch = Partial<Pick<Task, "title" | "detail" | "assignee" | "dueAt" | "priority" | "status">>;

export function updateTask(id: string, patch: TaskPatch): Task | null {
  const current = getTask(id);
  if (!current) return null;
  const now = Date.now();
  const status = patch.status ?? current.status;
  const completedAt = status === "done" ? (current.status === "done" ? current.completedAt : now) : null;
  const dueAt = patch.dueAt === undefined ? current.dueAt : patch.dueAt;
  // A new due date restarts the overdue watch so the task can be chased again.
  const overdueNotifiedAt = patch.dueAt !== undefined && patch.dueAt !== current.dueAt ? null : current.overdueNotifiedAt;
  database.prepare(`
    UPDATE konan_tasks
    SET title = ?, detail = ?, assignee = ?, due_at = ?, priority = ?, status = ?,
        completed_at = ?, overdue_notified_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.title ?? current.title,
    patch.detail ?? current.detail,
    patch.assignee === undefined ? current.assignee : patch.assignee,
    dueAt,
    patch.priority ?? current.priority,
    status,
    completedAt,
    overdueNotifiedAt,
    now,
    id,
  );
  if (status !== "open") {
    database.prepare("UPDATE konan_follow_ups SET status = 'cancelled' WHERE task_id = ? AND status = 'scheduled'").run(id);
  }
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  return database.prepare("DELETE FROM konan_tasks WHERE id = ?").run(id).changes > 0;
}

export function overdueTasks(now: number): Task[] {
  return (database.prepare(`
    SELECT ${taskColumns} FROM konan_tasks
    WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ? AND overdue_notified_at IS NULL
  `).all(now) as unknown[]).map(mapTask);
}

export function markTaskOverdueNotified(id: string, at: number) {
  database.prepare("UPDATE konan_tasks SET overdue_notified_at = ? WHERE id = ?").run(at, id);
}

const followUpColumns = `
  id, task_id AS taskId, at, note, repeat_every_ms AS repeatEveryMs, status,
  submission_id AS submissionId,
  fired_at AS firedAt, output, error, created_by AS createdBy, created_at AS createdAt
`;

export function listFollowUps(taskId: string): FollowUp[] {
  return database.prepare(`SELECT ${followUpColumns} FROM konan_follow_ups WHERE task_id = ? ORDER BY at DESC`).all(taskId) as unknown as FollowUp[];
}

export function getFollowUp(id: string): FollowUp | null {
  const row = database.prepare(`SELECT ${followUpColumns} FROM konan_follow_ups WHERE id = ?`).get(id);
  return row ? row as unknown as FollowUp : null;
}

export function createFollowUp(input: { id?: string; taskId: string; at: number; note?: string; repeatEveryMs?: number | null; createdBy: Author }): FollowUp {
  const followUp: FollowUp = {
    id: input.id ?? randomUUID(),
    taskId: input.taskId,
    at: input.at,
    note: input.note ?? "",
    repeatEveryMs: input.repeatEveryMs ?? null,
    status: "scheduled",
    submissionId: null,
    firedAt: null,
    output: null,
    error: null,
    createdBy: input.createdBy,
    createdAt: Date.now(),
  };
  database.prepare(`
    INSERT OR IGNORE INTO konan_follow_ups (id, task_id, at, note, repeat_every_ms, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(followUp.id, followUp.taskId, followUp.at, followUp.note, followUp.repeatEveryMs, followUp.status, followUp.createdBy, followUp.createdAt);
  return getFollowUp(followUp.id) ?? followUp;
}

export function updateFollowUp(id: string, patch: Partial<Pick<FollowUp, "at" | "note" | "repeatEveryMs" | "status">>): FollowUp | null {
  const current = getFollowUp(id);
  if (!current) return null;
  const status = patch.status ?? current.status;
  // Rescheduling a row that already ran must start a fresh run: otherwise the next execution
  // reuses the old Flue submission and re-publishes its result instead of dispatching again.
  const rerun = status === "scheduled" && current.status !== "scheduled";
  database.prepare(
    rerun
      ? "UPDATE konan_follow_ups SET at = ?, note = ?, repeat_every_ms = ?, status = ?, submission_id = NULL, fired_at = NULL, output = NULL, error = NULL WHERE id = ?"
      : "UPDATE konan_follow_ups SET at = ?, note = ?, repeat_every_ms = ?, status = ? WHERE id = ?",
  ).run(patch.at ?? current.at, patch.note ?? current.note, patch.repeatEveryMs === undefined ? current.repeatEveryMs : patch.repeatEveryMs, status, id);
  return getFollowUp(id);
}

export function deleteFollowUp(id: string): boolean {
  return database.prepare("DELETE FROM konan_follow_ups WHERE id = ?").run(id).changes > 0;
}

export function dueFollowUps(now: number): FollowUp[] {
  return database.prepare(`SELECT ${followUpColumns} FROM konan_follow_ups WHERE status = 'scheduled' AND at <= ? ORDER BY at ASC`).all(now) as unknown as FollowUp[];
}

export function listRunningFollowUps(): FollowUp[] {
  return database.prepare(`SELECT ${followUpColumns} FROM konan_follow_ups WHERE status = 'running' ORDER BY fired_at ASC`).all() as unknown as FollowUp[];
}

/**
 * True when a follow-up is already covering this task: one is scheduled or running, or one fired
 * at or after `since`. The overdue sweep uses it so a task whose follow-up fires in the same tick
 * it goes overdue (the default: follow-up at the due time) is not chased twice.
 */
export function hasFollowUpCovering(taskId: string, since: number): boolean {
  return database.prepare(
    "SELECT 1 FROM konan_follow_ups WHERE task_id = ? AND (status IN ('scheduled', 'running') OR (status = 'fired' AND fired_at >= ?)) LIMIT 1",
  ).get(taskId, since) !== undefined;
}

export function startFollowUp(id: string, firedAt: number): boolean {
  return database.prepare("UPDATE konan_follow_ups SET status = 'running', fired_at = ?, error = NULL WHERE id = ? AND status = 'scheduled'").run(firedAt, id).changes > 0;
}

export function attachFollowUpSubmission(id: string, submissionId: string): boolean {
  return database.prepare("UPDATE konan_follow_ups SET submission_id = ? WHERE id = ? AND status = 'running'").run(submissionId, id).changes > 0;
}

export function finishFollowUp(id: string, output: string): boolean {
  return database.prepare("UPDATE konan_follow_ups SET status = 'fired', output = ?, error = NULL WHERE id = ? AND status = 'running'").run(output, id).changes > 0;
}

export function completeFollowUp(
  id: string,
  completion: {
    output: string;
    nextFollowUp?: {
      at: number;
      note?: string;
      repeatEveryMs?: number | null;
      createdBy: Author;
    };
    notification: {
      kind: NotificationKind;
      title: string;
      body?: string;
      taskId?: string | null;
      conversationId?: string | null;
    };
  },
): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = getFollowUp(id);
    const changed = database.prepare("UPDATE konan_follow_ups SET status = 'fired', output = ?, error = NULL WHERE id = ? AND status = 'running'").run(completion.output, id).changes > 0;
    if (!changed) {
      database.exec("ROLLBACK");
      return false;
    }
    createNotification(completion.notification);
    if (current && completion.nextFollowUp) {
      createFollowUp({ taskId: current.taskId, ...completion.nextFollowUp });
    }
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function failFollowUp(id: string, error: string): boolean {
  return database.prepare("UPDATE konan_follow_ups SET status = 'failed', error = ? WHERE id = ? AND status IN ('scheduled', 'running')").run(error, id).changes > 0;
}

const notificationColumns = `
  id, kind, title, body, task_id AS taskId, conversation_id AS conversationId,
  created_at AS createdAt, read_at AS readAt
`;

export function listNotifications(limit = 50): Notification[] {
  return database.prepare(`SELECT ${notificationColumns} FROM konan_notifications ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as Notification[];
}

export function unreadNotificationCount(): number {
  const row = database.prepare("SELECT count(*) AS count FROM konan_notifications WHERE read_at IS NULL").get() as { count: number };
  return row.count;
}

export function createNotification(input: { id?: string; kind: NotificationKind; title: string; body?: string; taskId?: string | null; conversationId?: string | null }): Notification {
  const notification: Notification = {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: (input.body ?? "").slice(0, 600),
    taskId: input.taskId ?? null,
    conversationId: input.conversationId ?? null,
    createdAt: Date.now(),
    readAt: null,
  };
  database.prepare(`
    INSERT OR IGNORE INTO konan_notifications (id, kind, title, body, task_id, conversation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(notification.id, notification.kind, notification.title, notification.body, notification.taskId, notification.conversationId, notification.createdAt);
  const stored = database.prepare(`SELECT ${notificationColumns} FROM konan_notifications WHERE id = ?`).get(notification.id);
  return stored ? stored as unknown as Notification : notification;
}

export function markNotificationsRead(ids?: string[]): number {
  const now = Date.now();
  if (!ids) return Number(database.prepare("UPDATE konan_notifications SET read_at = ? WHERE read_at IS NULL").run(now).changes);
  let changed = 0;
  const statement = database.prepare("UPDATE konan_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL");
  for (const id of ids) changed += Number(statement.run(now, id).changes);
  return changed;
}

export function getTaskView(task: Task): TaskView {
  const followUps = listFollowUps(task.id);
  const next = followUps.filter((followUp) => followUp.status === "scheduled").map((followUp) => followUp.at).sort((left, right) => left - right)[0] ?? null;
  return { ...task, followUps, nextFollowUpAt: next };
}

export function listTaskViews(status?: TaskStatus): TaskView[] {
  return listTasks(status).map(getTaskView);
}
