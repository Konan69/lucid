import { init } from "@flue/runtime";
import { Cron } from "croner";
import { Vivid } from "./agents/vivid.ts";
import { attachRoutineSubmission, failRoutineRun, finishRoutineRun, getRoutine, listRunningRoutineRuns, listRoutineRuns, listRoutines, setRoutineScheduleState, startRoutineRun, type Routine, type RoutineRun } from "./routine-store.ts";
import { upsertConversation } from "./thread-store.ts";

export type RoutineView = Routine & { nextRunAt: number | null; runs: RoutineRun[] };
type RoutineSignalAttributes = {
  routineId: string;
  routineName: string;
  libraryFolderId?: string;
  scheduledAt: string;
};
const jobs = new Map<string, Cron>();
const inFlightRuns = new Set<string>();
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
export function validateRoutineSchedule(cron: string, timezone: string) { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); const probe = new Cron(cron, { paused: true, timezone }); probe.stop(); }
function nextRunAt(routine: Routine): number | null {
  if (!routine.enabled) return null; const active = jobs.get(routine.id); if (active) return active.nextRun()?.getTime() ?? null;
  try { const probe = new Cron(routine.cron, { paused: true, timezone: routine.timezone }); const next = probe.nextRun()?.getTime() ?? null; probe.stop(); return next; } catch { return null; }
}
async function executeRoutine(routine: Routine, run: RoutineRun) {
  if (inFlightRuns.has(run.id)) return; inFlightRuns.add(run.id);
  try {
    const instruction = routine.libraryFolderId ? `${routine.prompt}\n\nFor this routine, search the Library with folderId "${routine.libraryFolderId}" before answering. Use only results from that folder and its descendants, and cite every source used.` : routine.prompt;
    await upsertConversation({ archived: false, id: run.conversationId, title: routine.name, preview: `Routine: ${routine.prompt}`.slice(0, 500), updatedAt: run.startedAt });
    const agent = init(Vivid, { id: run.conversationId }); let submissionId = run.submissionId;
    if (!submissionId) {
      const attributes: RoutineSignalAttributes = {
        routineId: routine.id,
        routineName: routine.name,
        scheduledAt: new Date(run.startedAt).toISOString(),
      };
      if (routine.libraryFolderId) attributes.libraryFolderId = routine.libraryFolderId;
      const receipt = await agent.dispatch({
        idempotencyKey: run.id,
        message: { kind: "signal", type: "schedule", body: instruction, attributes },
      });
      submissionId = receipt.submissionId;
      await attachRoutineSubmission(run.id, submissionId);
    }
    const reply = await agent.read(submissionId); if (!await finishRoutineRun(run.id, reply.text)) return;
    await upsertConversation({ archived: false, id: run.conversationId, title: routine.name, preview: reply.text.slice(0, 500), updatedAt: Date.now() });
  } catch (error) { await failRoutineRun(run.id, errorMessage(error).slice(0, 1000)); } finally { inFlightRuns.delete(run.id); }
}
export async function runRoutineNow(routine: Routine): Promise<RoutineRun> {
  const current = await getRoutine(routine.id); await setRoutineScheduleState(routine.id, current?.nextExpectedAt ?? null, null);
  const run = await startRoutineRun(routine.id); void executeRoutine(routine, run); return run;
}
export function syncRoutineJob(routine: Routine) {
  jobs.get(routine.id)?.stop(); jobs.delete(routine.id);
  if (!routine.enabled) { void setRoutineScheduleState(routine.id, null); return; }
  const job = new Cron(routine.cron, { timezone: routine.timezone, protect: true, catch: (error) => console.error(`[routine:${routine.id}]`, error) }, () => {
    void (async () => { const current = await getRoutine(routine.id); if (current?.enabled) { await setRoutineScheduleState(current.id, jobs.get(current.id)?.nextRun()?.getTime() ?? null, null); await runRoutineNow(current); } })();
  });
  jobs.set(routine.id, job); void setRoutineScheduleState(routine.id, job.nextRun()?.getTime() ?? null);
}
export function removeRoutineJob(id: string) { jobs.get(id)?.stop(); jobs.delete(id); }
export async function getRoutineView(routine: Routine): Promise<RoutineView> { return { ...routine, nextRunAt: nextRunAt(routine), runs: await listRoutineRuns(routine.id) }; }
export async function listRoutineViews(): Promise<RoutineView[]> { return Promise.all((await listRoutines()).map(getRoutineView)); }

async function initializeRoutineJobs() {
  for (const storedRoutine of await listRoutines()) {
    try {
      if (storedRoutine.enabled && storedRoutine.nextExpectedAt && storedRoutine.nextExpectedAt < Date.now()) await setRoutineScheduleState(storedRoutine.id, null, storedRoutine.nextExpectedAt);
      const routine = await getRoutine(storedRoutine.id) ?? storedRoutine; syncRoutineJob(routine);
    } catch (error) { console.error(`[routine:${storedRoutine.id}] could not start`, error); }
  }
  for (const run of await listRunningRoutineRuns()) { const routine = await getRoutine(run.routineId); if (routine) void executeRoutine(routine, run); else await failRoutineRun(run.id, "The routine for this run no longer exists"); }
}
void initializeRoutineJobs();
