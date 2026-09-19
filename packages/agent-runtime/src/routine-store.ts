import { randomUUID } from "node:crypto";
import { asc, and, desc, eq } from "drizzle-orm";
import { db, schemaReady } from "./runtime-db.ts";
import { routineRuns, routines } from "./runtime-schema.ts";
import { decodeRoutine, decodeRoutineRun } from "./runtime-codecs.ts";

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

const routineSelection = {
  id: routines.id,
  name: routines.name,
  prompt: routines.prompt,
  cron: routines.cron,
  timezone: routines.timezone,
  libraryFolderId: routines.libraryFolderId,
  enabled: routines.enabled,
  nextExpectedAt: routines.nextExpectedAt,
  lastMissedAt: routines.lastMissedAt,
  createdAt: routines.createdAt,
  updatedAt: routines.updatedAt
};
const runSelection = {
  id: routineRuns.id,
  routineId: routineRuns.routineId,
  conversationId: routineRuns.conversationId,
  submissionId: routineRuns.submissionId,
  status: routineRuns.status,
  startedAt: routineRuns.startedAt,
  finishedAt: routineRuns.finishedAt,
  output: routineRuns.output,
  error: routineRuns.error
};

export async function listRoutines(): Promise<Routine[]> {
  await schemaReady;
  return (await db.select(routineSelection).from(routines).orderBy(desc(routines.updatedAt))).map((row) => decodeRoutine(row));
}

export async function getRoutine(id: string): Promise<Routine | null> {
  await schemaReady;
  const rows = await db.select(routineSelection).from(routines).where(eq(routines.id, id));
  return rows[0] ? decodeRoutine(rows[0]) : null;
}

export async function createRoutine(input: Pick<Routine, "name" | "prompt" | "cron" | "timezone" | "libraryFolderId">): Promise<Routine> {
  await schemaReady;
  const now = Date.now();
  const routine: Routine = { ...input, id: randomUUID(), enabled: true, nextExpectedAt: null, lastMissedAt: null, createdAt: now, updatedAt: now };
  await db.insert(routines).values(routine);
  return routine;
}

export async function updateRoutine(id: string, patch: Partial<Pick<Routine, "name" | "prompt" | "cron" | "timezone" | "libraryFolderId" | "enabled">>): Promise<Routine | null> {
  const current = await getRoutine(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await db.update(routines).set({
    name: next.name, prompt: next.prompt, cron: next.cron, timezone: next.timezone,
    libraryFolderId: next.libraryFolderId, enabled: next.enabled, updatedAt: next.updatedAt
  }).where(eq(routines.id, id));
  return next;
}

export async function deleteRoutine(id: string): Promise<boolean> {
  const rows = await db.delete(routines).where(eq(routines.id, id)).returning({ id: routines.id });
  return rows.length > 0;
}

export async function setRoutineScheduleState(id: string, nextExpectedAt: number | null, lastMissedAt?: number | null): Promise<void> {
  await schemaReady;
  if (lastMissedAt === undefined) await db.update(routines).set({ nextExpectedAt }).where(eq(routines.id, id));
  else await db.update(routines).set({ nextExpectedAt, lastMissedAt }).where(eq(routines.id, id));
}

export async function listRoutineRuns(routineId: string, limit = 12): Promise<RoutineRun[]> {
  await schemaReady;
  return (await db.select(runSelection).from(routineRuns).where(eq(routineRuns.routineId, routineId)).orderBy(desc(routineRuns.startedAt)).limit(limit)).map((row) => decodeRoutineRun(row));
}

export async function listRunningRoutineRuns(): Promise<RoutineRun[]> {
  await schemaReady;
  return (await db.select(runSelection).from(routineRuns).where(eq(routineRuns.status, "running")).orderBy(asc(routineRuns.startedAt))).map((row) => decodeRoutineRun(row));
}

export async function startRoutineRun(routineId: string): Promise<RoutineRun> {
  await schemaReady;
  const run: RoutineRun = { id: randomUUID(), routineId, conversationId: `routine-${routineId}`, submissionId: null, status: "running", startedAt: Date.now(), finishedAt: null, output: null, error: null };
  await db.insert(routineRuns).values(run);
  return run;
}

export async function attachRoutineSubmission(runId: string, submissionId: string): Promise<void> {
  await db.update(routineRuns).set({ submissionId }).where(eq(routineRuns.id, runId));
}

export async function finishRoutineRun(runId: string, output: string): Promise<boolean> {
  const rows = await db.update(routineRuns).set({ status: "succeeded", finishedAt: Date.now(), output, error: null }).where(and(eq(routineRuns.id, runId), eq(routineRuns.status, "running"))).returning({ id: routineRuns.id });
  return rows.length > 0;
}

export async function failRoutineRun(runId: string, error: string): Promise<boolean> {
  const rows = await db.update(routineRuns).set({ status: "failed", finishedAt: Date.now(), error }).where(and(eq(routineRuns.id, runId), eq(routineRuns.status, "running"))).returning({ id: routineRuns.id });
  return rows.length > 0;
}
