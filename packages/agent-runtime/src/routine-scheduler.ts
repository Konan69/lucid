import { init } from "@flue/runtime";
import { Cron } from "croner";
import { Effect, Schema } from "effect";
import { Vivid } from "./agents/vivid.ts";
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

export type RoutineView = Routine & { nextRunAt: number | null; runs: RoutineRun[] };
type RoutineSignalAttributes = {
  routineId: string;
  routineName: string;
  libraryFolderId?: string;
  scheduledAt: string;
};

/** A persistence adapter rejected a routine scheduler operation. */
export class RoutineStoreFailure extends Schema.TaggedError<RoutineStoreFailure>()("RoutineStoreFailure", {
  operation: Schema.String,
  message: Schema.String,
}, { title: "Routine store failure" }) {}

/** A cron expression or timezone cannot produce a safe schedule. */
export class InvalidRoutineSchedule extends Schema.TaggedError<InvalidRoutineSchedule>()("InvalidRoutineSchedule", {
  message: Schema.String,
}, { title: "Invalid Routine schedule" }) {}

/** Flue could not dispatch or read a Routine occurrence. */
export class RoutineExecutionFailure extends Schema.TaggedError<RoutineExecutionFailure>()("RoutineExecutionFailure", {
  operation: Schema.String,
  message: Schema.String,
}, { title: "Routine execution failure" }) {}

export type RoutineSchedulerFailure = RoutineStoreFailure | InvalidRoutineSchedule | RoutineExecutionFailure;

/** The app owns root fibers started by Cron and HTTP callbacks. */
export interface RoutineSchedulerBoundary {
  readonly run: (label: string, effect: Effect.Effect<void, RoutineSchedulerFailure>) => void;
}

const jobs = new Map<string, Cron>();
const inFlightRuns = new Set<string>();

/** Lifts the legacy Promise store seam into the scheduler's typed failure channel. */
const storeOperation = Effect.fn("RoutineScheduler.storeOperation")(function*<Value>(
  operation: string,
  evaluate: () => Promise<Value>,
) {
  return yield* Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => new RoutineStoreFailure({ operation, message: error.message })),
  );
});

/** Lifts one Flue Promise into a distinct execution failure. */
const executionOperation = Effect.fn("RoutineScheduler.executionOperation")(function*<Value>(
  operation: string,
  evaluate: () => Promise<Value>,
) {
  return yield* Effect.tryPromise(evaluate).pipe(
    Effect.mapError((error) => new RoutineExecutionFailure({ operation, message: error.message })),
  );
});

/** Constructs a stopped Cron probe so validation never schedules work. */
const cronProbe = Effect.fn("RoutineScheduler.cronProbe")(function*(cron: string, timezone: string) {
  return yield* Effect.try({
    try: () => {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
      return new Cron(cron, { paused: true, timezone });
    },
    catch: (error) => new InvalidRoutineSchedule({ message: String(error) }),
  });
});

/** Validates both timezone and cron syntax without registering a job. */
export const validateRoutineSchedule = Effect.fn("RoutineScheduler.validateSchedule")(function*(
  cron: string,
  timezone: string,
) {
  const probe = yield* cronProbe(cron, timezone);
  probe.stop();
});

/** Reads the next durable occurrence from an active job or validated probe. */
const nextRunAt = Effect.fn("RoutineScheduler.nextRunAt")(function*(routine: Routine) {
  if (!routine.enabled) return null;
  const active = jobs.get(routine.id);
  if (active !== undefined) {
    const next = active.nextRun();
    return next === null ? null : next.getTime();
  }
  const probe = yield* cronProbe(routine.cron, routine.timezone);
  const next = probe.nextRun();
  probe.stop();
  return next === null ? null : next.getTime();
});

/** Records one typed execution failure while preserving the running-run compare-and-set. */
const recordRoutineFailure = Effect.fn("RoutineScheduler.recordFailure")(function*(
  run: RoutineRun,
  failure: RoutineStoreFailure | RoutineExecutionFailure,
) {
  yield* storeOperation("fail routine run", () => failRoutineRun(run.id, failure.message.slice(0, 1000)));
});

/** Executes one durable Routine occurrence and resumes an attached submission after restart. */
const executeClaimedRoutine = Effect.fn("RoutineScheduler.executeClaimed")(function*(
  routine: Routine,
  run: RoutineRun,
) {
  const instruction = routine.libraryFolderId === null
    ? routine.prompt
    : `${routine.prompt}\n\nFor this routine, search the Library with folderId "${routine.libraryFolderId}" before answering. Use only results from that folder and its descendants, and cite every source used.`;
  yield* storeOperation("upsert routine conversation", () => upsertConversation({
    archived: false,
    id: run.conversationId,
    title: routine.name,
    preview: `Routine: ${routine.prompt}`.slice(0, 500),
    updatedAt: run.startedAt,
  }));

  const agent = init(Vivid, { id: run.conversationId });
  let submissionId = run.submissionId;
  if (submissionId === null) {
    const attributes: RoutineSignalAttributes = {
      routineId: routine.id,
      routineName: routine.name,
      scheduledAt: new Date(run.startedAt).toISOString(),
    };
    if (routine.libraryFolderId !== null) attributes.libraryFolderId = routine.libraryFolderId;
    const receipt = yield* executionOperation("dispatch routine", () => agent.dispatch({
      idempotencyKey: run.id,
      message: { kind: "signal", type: "schedule", body: instruction, attributes },
    }));
    submissionId = receipt.submissionId;
    yield* storeOperation("attach routine submission", () => attachRoutineSubmission(run.id, receipt.submissionId));
  }

  const reply = yield* executionOperation("read routine", () => agent.read(submissionId));
  const finished = yield* storeOperation("finish routine run", () => finishRoutineRun(run.id, reply.text));
  if (!finished) return;
  yield* storeOperation("update routine conversation", () => upsertConversation({
    archived: false,
    id: run.conversationId,
    title: routine.name,
    preview: reply.text.slice(0, 500),
    updatedAt: Date.now(),
  }));
});

/** Owns in-flight membership and records every expected occurrence failure. */
const executeRoutine = Effect.fn("RoutineScheduler.execute")(function*(routine: Routine, run: RoutineRun) {
  const acquired = yield* Effect.sync(() => {
    if (inFlightRuns.has(run.id)) return false;
    inFlightRuns.add(run.id);
    return true;
  });
  if (!acquired) return;
  yield* Effect.acquireUseRelease(
    Effect.succeed(undefined),
    () => executeClaimedRoutine(routine, run).pipe(
      Effect.catch((failure) => recordRoutineFailure(run, failure)),
    ),
    () => Effect.sync(() => { inFlightRuns.delete(run.id); }),
  );
});

/** Starts one durable occurrence and delegates its observed root fiber to the app. */
export const runRoutineNow = Effect.fn("RoutineScheduler.runNow")(function*(
  routine: Routine,
  boundary: RoutineSchedulerBoundary,
) {
  const current = yield* storeOperation("reload routine", () => getRoutine(routine.id));
  yield* storeOperation("clear missed routine state", () => setRoutineScheduleState(
    routine.id,
    current === null ? null : current.nextExpectedAt,
    null,
  ));
  const run = yield* storeOperation("start routine run", () => startRoutineRun(routine.id));
  yield* Effect.sync(() => boundary.run(`routine:${run.id}`, executeRoutine(routine, run)));
  return run;
});

/** Executes the current enabled Routine after a Cron callback fires. */
const executeScheduledRoutine = Effect.fn("RoutineScheduler.executeScheduled")(function*(
  routineId: string,
  boundary: RoutineSchedulerBoundary,
) {
  const current = yield* storeOperation("read scheduled routine", () => getRoutine(routineId));
  if (current === null || !current.enabled) return;
  const job = jobs.get(current.id);
  const next = job === undefined ? null : job.nextRun();
  yield* storeOperation("advance routine schedule", () => setRoutineScheduleState(
    current.id,
    next === null ? null : next.getTime(),
    null,
  ));
  yield* runRoutineNow(current, boundary);
});

/** Replaces one Cron registration and persists its next expected occurrence. */
export const syncRoutineJob = Effect.fn("RoutineScheduler.syncJob")(function*(
  routine: Routine,
  boundary: RoutineSchedulerBoundary,
) {
  const existing = jobs.get(routine.id);
  if (existing !== undefined) existing.stop();
  jobs.delete(routine.id);
  if (!routine.enabled) {
    yield* storeOperation("disable routine schedule", () => setRoutineScheduleState(routine.id, null));
    return;
  }

  yield* validateRoutineSchedule(routine.cron, routine.timezone);
  const job = new Cron(
    routine.cron,
    {
      timezone: routine.timezone,
      protect: true,
      catch: (error) => {
        const failure = Effect.fail(new InvalidRoutineSchedule({ message: String(error) }));
        boundary.run(`routine:${routine.id}:cron`, failure);
      },
    },
    () => boundary.run(
      `routine:${routine.id}:tick`,
      executeScheduledRoutine(routine.id, boundary),
    ),
  );
  jobs.set(routine.id, job);
  const next = job.nextRun();
  yield* storeOperation("persist routine schedule", () => setRoutineScheduleState(
    routine.id,
    next === null ? null : next.getTime(),
  ));
});

/** Removes one Cron registration; callers own deleting persistent state. */
export const removeRoutineJob = Effect.fn("RoutineScheduler.removeJob")(function*(id: string) {
  yield* Effect.sync(() => {
    const existing = jobs.get(id);
    if (existing !== undefined) existing.stop();
    jobs.delete(id);
  });
});

/** Builds one Routine response from durable runs and validated schedule state. */
export const getRoutineView = Effect.fn("RoutineScheduler.getView")(function*(routine: Routine) {
  const scheduledAt = yield* nextRunAt(routine);
  const runs = yield* storeOperation("list routine runs", () => listRoutineRuns(routine.id));
  return { ...routine, nextRunAt: scheduledAt, runs } satisfies RoutineView;
});

/** Lists Routine views sequentially so one shared database pool is not fanned out. */
export const listRoutineViews = Effect.fn("RoutineScheduler.listViews")(function*() {
  const routines = yield* storeOperation("list routines", listRoutines);
  return yield* Effect.forEach(routines, getRoutineView, { concurrency: 1 });
});

/** Restores Cron jobs and durable running occurrences after process startup. */
export const initializeRoutineScheduler = Effect.fn("RoutineScheduler.initialize")(function*(
  boundary: RoutineSchedulerBoundary,
) {
  const storedRoutines = yield* storeOperation("list startup routines", listRoutines);
  for (const storedRoutine of storedRoutines) {
    const restore = Effect.fn("RoutineScheduler.restoreJob")(function*() {
      if (
        storedRoutine.enabled &&
        storedRoutine.nextExpectedAt !== null &&
        storedRoutine.nextExpectedAt < Date.now()
      ) {
        yield* storeOperation("record missed routine", () => setRoutineScheduleState(
          storedRoutine.id,
          null,
          storedRoutine.nextExpectedAt,
        ));
      }
      const refreshed = yield* storeOperation("reload startup routine", () => getRoutine(storedRoutine.id));
      yield* syncRoutineJob(refreshed ?? storedRoutine, boundary);
    })();
    yield* restore.pipe(Effect.catch((failure) => Effect.logError(`routine:${storedRoutine.id}`, failure)));
  }

  const running = yield* storeOperation("list running routine runs", listRunningRoutineRuns);
  for (const run of running) {
    const routine = yield* storeOperation("read recovering routine", () => getRoutine(run.routineId));
    if (routine === null) {
      yield* storeOperation("fail orphan routine run", () => failRoutineRun(
        run.id,
        "The routine for this run no longer exists",
      ));
      continue;
    }
    yield* Effect.sync(() => boundary.run(`routine:${run.id}:recovery`, executeRoutine(routine, run)));
  }
});
