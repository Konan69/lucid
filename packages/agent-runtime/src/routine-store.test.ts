import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://vivid:vivid@127.0.0.1:5434/vivid_runtime";
const store = await import("./routine-store.ts");

void test("an unfinished routine run remains resumable by its Flue submission", async () => {
  const routine = await store.createRoutine({ name: "Morning brief", prompt: "Prepare the brief", cron: "0 9 * * *", timezone: "Africa/Lagos", libraryFolderId: null });
  const run = await store.startRoutineRun(routine.id); await store.attachRoutineSubmission(run.id, "submission-456");
  const resumable = (await store.listRunningRoutineRuns()).find((item) => item.id === run.id);
  assert.equal(resumable?.submissionId, "submission-456"); assert.equal(await store.finishRoutineRun(run.id, "First durable result"), true); assert.equal(await store.finishRoutineRun(run.id, "Duplicate result"), false); assert.equal((await store.listRoutineRuns(routine.id))[0]?.output, "First durable result");
});
