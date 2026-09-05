import { init } from "@flue/runtime";
import { Cron } from "croner";
import { Vivid } from "./agents/konan.ts";
import {
  attachRoutineSubmission,
  failRoutineRun,
  finishRoutineRun,
  getRoutine,
  listRunningRoutineRuns,
  listRoutineRuns,
  listRoutines,
  setRoutineScheduleState,
  startRoutineRun,
  type Routine,
  type RoutineRun,
} from "./routine-store.ts";
import { upsertConversation } from "./thread-store.ts";

export type RoutineView = Routine & {
  nextRunAt: number | null;
  runs: RoutineRun[];
};

const jobs = new Map<string, Cron>();
const inFlightRuns = new Set<string>();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function validateRoutineSchedule(cron: string, timezone: string) {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  const probe = new Cron(cron, { paused: true, timezone });
  probe.stop();
}

function nextRunAt(routine: Routine): number | null {
  if (!routine.enabled) return null;
  const active = jobs.get(routine.id);
  if (active) return active.nextRun()?.getTime() ?? null;
  try {
    const probe = new Cron(routine.cron, { paused: true, timezone: routine.timezone });
    const next = probe.nextRun()?.getTime() ?? null;
    probe.stop();
    return next;
  } catch {
    return null;
  }
}

async function executeRoutine(routine: Routine, run: RoutineRun) {
  if (inFlightRuns.has(run.id)) return;
  inFlightRuns.add(run.id);
  try {
    const instruction = routine.libraryFolderId
      ? `${routine.prompt}\n\nFor this routine, search the Library with folderId "${routine.libraryFolderId}" before answering. Use only results from that folder and its descendants, and cite every source used.`
      : routine.prompt;
    upsertConversation({
      archived: false,
      id: run.conversationId,
      title: routine.name,
      preview: `Routine: ${routine.prompt}`.slice(0, 500),
      updatedAt: run.startedAt,
    });
    const agent = init(Vivid, { id: run.conversationId });
    let submissionId = run.submissionId;
    if (!submissionId) {
      const receipt = await agent.dispatch({
        idempotencyKey: run.id,
        message: {
          kind: "signal",
          type: "schedule",
          body: instruction,
          attributes: {
            routineId: routine.id,
            routineName: routine.name,
            ...(routine.libraryFolderId ? { libraryFolderId: routine.libraryFolderId } : {}),
            scheduledAt: new Date(run.startedAt).toISOString(),
          },
        },
      });
      submissionId = receipt.submissionId;
      attachRoutineSubmission(run.id, submissionId);
    }
    const reply = await agent.read(submissionId);
    if (!finishRoutineRun(run.id, reply.text)) return;
    upsertConversation({
      archived: false,
      id: run.conversationId,
      title: routine.name,
      preview: reply.text.slice(0, 500),
      updatedAt: Date.now(),
    });
  } catch (error) {
    failRoutineRun(run.id, errorMessage(error).slice(0, 1000));
  } finally {
    inFlightRuns.delete(run.id);
  }
}

export function runRoutineNow(routine: Routine): RoutineRun {
  setRoutineScheduleState(routine.id, getRoutine(routine.id)?.nextExpectedAt ?? null, null);
  const run = startRoutineRun(routine.id);
  void executeRoutine(routine, run);
  return run;
}

export function syncRoutineJob(routine: Routine) {
  jobs.get(routine.id)?.stop();
  jobs.delete(routine.id);
  if (!routine.enabled) {
    setRoutineScheduleState(routine.id, null);
    return;
  }

  const job = new Cron(
    routine.cron,
    {
      timezone: routine.timezone,
      protect: true,
      catch: (error) => console.error(`[routine:${routine.id}]`, error),
    },
    () => {
      const current = getRoutine(routine.id);
      if (current?.enabled) {
        setRoutineScheduleState(current.id, jobs.get(current.id)?.nextRun()?.getTime() ?? null, null);
        runRoutineNow(current);
      }
    },
  );
  jobs.set(routine.id, job);
  setRoutineScheduleState(routine.id, job.nextRun()?.getTime() ?? null);
}

export function removeRoutineJob(id: string) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function getRoutineView(routine: Routine): RoutineView {
  return { ...routine, nextRunAt: nextRunAt(routine), runs: listRoutineRuns(routine.id) };
}

export function listRoutineViews(): RoutineView[] {
  return listRoutines().map(getRoutineView);
}

for (const storedRoutine of listRoutines()) {
  try {
    if (storedRoutine.enabled && storedRoutine.nextExpectedAt && storedRoutine.nextExpectedAt < Date.now()) {
      setRoutineScheduleState(storedRoutine.id, null, storedRoutine.nextExpectedAt);
    }
    const routine = getRoutine(storedRoutine.id) ?? storedRoutine;
    syncRoutineJob(routine);
  } catch (error) {
    console.error(`[routine:${storedRoutine.id}] could not start`, error);
  }
}

setTimeout(() => {
  for (const run of listRunningRoutineRuns()) {
    const routine = getRoutine(run.routineId);
    if (routine) void executeRoutine(routine, run);
    else failRoutineRun(run.id, "The routine for this run no longer exists");
  }
}, 1500).unref();
