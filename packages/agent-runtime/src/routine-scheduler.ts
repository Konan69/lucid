import { init } from "@flue/runtime";
import { Cron } from "croner";
import { Konan } from "./agents/konan.ts";
import {
  attachRoutineSubmission,
  failRoutineRun,
  finishRoutineRun,
  getRoutine,
  listRoutineRuns,
  listRoutines,
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
  try {
    upsertConversation({
      id: run.conversationId,
      title: routine.name,
      preview: `Routine: ${routine.prompt}`.slice(0, 500),
      updatedAt: run.startedAt,
    });
    const agent = init(Konan, { id: run.conversationId });
    const receipt = await agent.dispatch({
      idempotencyKey: run.id,
      message: {
        kind: "signal",
        type: "schedule",
        body: routine.prompt,
        attributes: {
          routineId: routine.id,
          routineName: routine.name,
          scheduledAt: new Date(run.startedAt).toISOString(),
        },
      },
    });
    attachRoutineSubmission(run.id, receipt.submissionId);
    const reply = await agent.read(receipt);
    finishRoutineRun(run.id, reply.text);
    upsertConversation({
      id: run.conversationId,
      title: routine.name,
      preview: reply.text.slice(0, 500),
      updatedAt: Date.now(),
    });
  } catch (error) {
    failRoutineRun(run.id, errorMessage(error).slice(0, 1000));
  }
}

export function runRoutineNow(routine: Routine): RoutineRun {
  const run = startRoutineRun(routine.id);
  void executeRoutine(routine, run);
  return run;
}

export function syncRoutineJob(routine: Routine) {
  jobs.get(routine.id)?.stop();
  jobs.delete(routine.id);
  if (!routine.enabled) return;

  const job = new Cron(
    routine.cron,
    {
      timezone: routine.timezone,
      protect: true,
      catch: (error) => console.error(`[routine:${routine.id}]`, error),
    },
    () => {
      const current = getRoutine(routine.id);
      if (current?.enabled) runRoutineNow(current);
    },
  );
  jobs.set(routine.id, job);
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

for (const routine of listRoutines()) {
  try {
    syncRoutineJob(routine);
  } catch (error) {
    console.error(`[routine:${routine.id}] could not start`, error);
  }
}
