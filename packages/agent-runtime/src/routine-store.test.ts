import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(join(tmpdir(), "vivid-routine-store-"));
process.env.KONAN_RUNTIME_DB = join(stateDir, "runtime.sqlite");

const store = await import("./routine-store.ts");

test("an unfinished routine run remains resumable by its Flue submission", () => {
  const routine = store.createRoutine({
    name: "Morning brief",
    prompt: "Prepare the brief",
    cron: "0 9 * * *",
    timezone: "Africa/Lagos",
    libraryFolderId: null,
  });
  const run = store.startRoutineRun(routine.id);
  store.attachRoutineSubmission(run.id, "submission-456");

  const resumable = store.listRunningRoutineRuns();
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0]?.submissionId, "submission-456");
  assert.equal(store.finishRoutineRun(run.id, "First durable result"), true);
  assert.equal(store.finishRoutineRun(run.id, "Duplicate result"), false);
  assert.equal(store.listRoutineRuns(routine.id)[0]?.output, "First durable result");
});
