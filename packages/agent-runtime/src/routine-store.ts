import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
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

const routineColumns = `
  id, name, prompt, cron, timezone,
  enabled, created_at AS createdAt, updated_at AS updatedAt
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

export function createRoutine(input: Pick<Routine, "name" | "prompt" | "cron" | "timezone">): Routine {
  const now = Date.now();
  const routine: Routine = {
    ...input,
    id: randomUUID(),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  database.prepare(`
    INSERT INTO konan_routines (id, name, prompt, cron, timezone, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(routine.id, routine.name, routine.prompt, routine.cron, routine.timezone, 1, now, now);
  return routine;
}

export function updateRoutine(
  id: string,
  patch: Partial<Pick<Routine, "name" | "prompt" | "cron" | "timezone" | "enabled">>,
): Routine | null {
  const current = getRoutine(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  database.prepare(`
    UPDATE konan_routines
    SET name = ?, prompt = ?, cron = ?, timezone = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.prompt, next.cron, next.timezone, next.enabled ? 1 : 0, next.updatedAt, id);
  return next;
}

export function deleteRoutine(id: string): boolean {
  return database.prepare("DELETE FROM konan_routines WHERE id = ?").run(id).changes > 0;
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

export function finishRoutineRun(runId: string, output: string) {
  database.prepare(`
    UPDATE konan_routine_runs
    SET status = 'succeeded', finished_at = ?, output = ?, error = NULL
    WHERE id = ?
  `).run(Date.now(), output, runId);
}

export function failRoutineRun(runId: string, error: string) {
  database.prepare(`
    UPDATE konan_routine_runs
    SET status = 'failed', finished_at = ?, error = ?
    WHERE id = ?
  `).run(Date.now(), error, runId);
}
