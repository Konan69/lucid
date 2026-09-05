import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  libraryFolderId: string | null;
  enabled: boolean;
  nextExpectedAt: number | null;
  lastMissedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type RoutineRunStatus = "running" | "succeeded" | "failed";

export type RoutineRun = {
  id: string;
  routineId: string;
  conversationId: string;
  submissionId: string | null;
  status: RoutineRunStatus;
  startedAt: number;
  finishedAt: number | null;
  output: string | null;
  error: string | null;
};

const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS konan_routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_expected_at INTEGER,
    last_missed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS konan_routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES konan_routines(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    submission_id TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    output TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS konan_routine_runs_routine_started
    ON konan_routine_runs(routine_id, started_at DESC);
`);

const routineTableColumns = database.prepare("PRAGMA table_info(konan_routines)").all() as unknown as Array<{ name: string }>;
if (!routineTableColumns.some((column) => column.name === "next_expected_at")) {
  database.exec("ALTER TABLE konan_routines ADD COLUMN next_expected_at INTEGER");
}
if (!routineTableColumns.some((column) => column.name === "last_missed_at")) {
  database.exec("ALTER TABLE konan_routines ADD COLUMN last_missed_at INTEGER");
}
if (!routineTableColumns.some((column) => column.name === "library_folder_id")) {
  database.exec("ALTER TABLE konan_routines ADD COLUMN library_folder_id TEXT");
}

const routineColumns = `
  id, name, prompt, cron, timezone,
  enabled, next_expected_at AS nextExpectedAt, last_missed_at AS lastMissedAt,
  library_folder_id AS libraryFolderId,
  created_at AS createdAt, updated_at AS updatedAt
`;

function mapRoutine(row: unknown): Routine {
  const value = row as Omit<Routine, "enabled"> & { enabled: number };
  return { ...value, enabled: value.enabled === 1 };
}

export function listRoutines(): Routine[] {
  return (database.prepare(`SELECT ${routineColumns} FROM konan_routines ORDER BY updated_at DESC`).all() as unknown[])
    .map(mapRoutine);
}

export function getRoutine(id: string): Routine | null {
  const row = database.prepare(`SELECT ${routineColumns} FROM konan_routines WHERE id = ?`).get(id);
  return row ? mapRoutine(row) : null;
}

export function createRoutine(input: Pick<Routine, "name" | "prompt" | "cron" | "timezone" | "libraryFolderId">): Routine {
  const now = Date.now();
  const routine: Routine = {
    ...input,
    id: randomUUID(),
    enabled: true,
    nextExpectedAt: null,
    lastMissedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  database.prepare(`
    INSERT INTO konan_routines (id, name, prompt, cron, timezone, library_folder_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(routine.id, routine.name, routine.prompt, routine.cron, routine.timezone, routine.libraryFolderId, 1, now, now);
  return routine;
}

export function updateRoutine(
  id: string,
  patch: Partial<Pick<Routine, "name" | "prompt" | "cron" | "timezone" | "libraryFolderId" | "enabled">>,
): Routine | null {
  const current = getRoutine(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  database.prepare(`
    UPDATE konan_routines
    SET name = ?, prompt = ?, cron = ?, timezone = ?, library_folder_id = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.prompt, next.cron, next.timezone, next.libraryFolderId, next.enabled ? 1 : 0, next.updatedAt, id);
  return next;
}

export function deleteRoutine(id: string): boolean {
  return database.prepare("DELETE FROM konan_routines WHERE id = ?").run(id).changes > 0;
}

export function setRoutineScheduleState(id: string, nextExpectedAt: number | null, lastMissedAt?: number | null) {
  if (lastMissedAt === undefined) {
    database.prepare("UPDATE konan_routines SET next_expected_at = ? WHERE id = ?").run(nextExpectedAt, id);
  } else {
    database.prepare("UPDATE konan_routines SET next_expected_at = ?, last_missed_at = ? WHERE id = ?").run(nextExpectedAt, lastMissedAt, id);
  }
}

const runColumns = `
  id, routine_id AS routineId, conversation_id AS conversationId,
  submission_id AS submissionId, status, started_at AS startedAt,
  finished_at AS finishedAt, output, error
`;

export function listRoutineRuns(routineId: string, limit = 12): RoutineRun[] {
  return database.prepare(`
    SELECT ${runColumns} FROM konan_routine_runs
    WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?
  `).all(routineId, limit) as unknown as RoutineRun[];
}

export function listRunningRoutineRuns(): RoutineRun[] {
  return database.prepare(`SELECT ${runColumns} FROM konan_routine_runs WHERE status = 'running' ORDER BY started_at ASC`).all() as unknown as RoutineRun[];
}

export function startRoutineRun(routineId: string): RoutineRun {
  const run: RoutineRun = {
    id: randomUUID(),
    routineId,
    conversationId: `routine-${routineId}`,
    submissionId: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
  };
  database.prepare(`
    INSERT INTO konan_routine_runs
      (id, routine_id, conversation_id, status, started_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(run.id, run.routineId, run.conversationId, run.status, run.startedAt);
  return run;
}

export function attachRoutineSubmission(runId: string, submissionId: string) {
  database.prepare("UPDATE konan_routine_runs SET submission_id = ? WHERE id = ?")
    .run(submissionId, runId);
}

export function finishRoutineRun(runId: string, output: string): boolean {
  return database.prepare(`
    UPDATE konan_routine_runs
    SET status = 'succeeded', finished_at = ?, output = ?, error = NULL
    WHERE id = ? AND status = 'running'
  `).run(Date.now(), output, runId).changes > 0;
}

export function failRoutineRun(runId: string, error: string): boolean {
  return database.prepare(`
    UPDATE konan_routine_runs
    SET status = 'failed', finished_at = ?, error = ?
    WHERE id = ? AND status = 'running'
  `).run(Date.now(), error, runId).changes > 0;
}
