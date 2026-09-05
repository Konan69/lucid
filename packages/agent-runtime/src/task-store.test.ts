import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(join(tmpdir(), "vivid-follow-up-store-"));
process.env.KONAN_RUNTIME_DB = join(stateDir, "runtime.sqlite");

const store = await import("./task-store.ts");

test("a running follow-up preserves the Flue submission needed to resume it", () => {
  const task = store.createTask({
    title: "Signed NDA from Dami",
    origin: { kind: "manual" },
    createdBy: "you",
  });
  const followUp = store.createFollowUp({
    taskId: task.id,
    at: Date.now(),
    createdBy: "you",
  });

  assert.equal(store.startFollowUp(followUp.id, 1_700_000_000_000), true);
  assert.equal(store.attachFollowUpSubmission(followUp.id, "submission-123"), true);

  const resumable = store.listRunningFollowUps();
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0]?.submissionId, "submission-123");
  assert.equal(resumable[0]?.firedAt, 1_700_000_000_000);
});

test("a recovered follow-up can only be finalized once", () => {
  const task = store.createTask({
    title: "Review investor notes",
    origin: { kind: "manual" },
    createdBy: "you",
  });
  const followUp = store.createFollowUp({ taskId: task.id, at: Date.now(), createdBy: "you" });
  store.startFollowUp(followUp.id, Date.now());

  assert.equal(store.finishFollowUp(followUp.id, "First durable result"), true);
  assert.equal(store.finishFollowUp(followUp.id, "Duplicate result"), false);
  assert.equal(store.getFollowUp(followUp.id)?.output, "First durable result");
});

test("follow-up completion and its notification materialize once", () => {
  const task = store.createTask({
    title: "Confirm launch date",
    assignee: "Dami",
    origin: { kind: "manual" },
    createdBy: "you",
  });
  const followUp = store.createFollowUp({ taskId: task.id, at: Date.now(), createdBy: "you" });
  store.startFollowUp(followUp.id, Date.now());

  const completion = {
    output: "Dami still needs to confirm the launch date.",
    nextFollowUp: {
      at: 1_900_000_000_000,
      note: "Keep chasing",
      repeatEveryMs: 86_400_000,
      createdBy: "vivid" as const,
    },
    notification: {
      kind: "follow-up" as const,
      title: "Chased Dami: Confirm launch date",
      body: "Dami still needs to confirm the launch date.",
      taskId: task.id,
      conversationId: task.conversationId,
    },
  };

  assert.equal(store.completeFollowUp(followUp.id, completion), true);
  assert.equal(store.completeFollowUp(followUp.id, completion), false);
  assert.equal(store.listNotifications().filter((item) => item.taskId === task.id).length, 1);
  assert.equal(store.listFollowUps(task.id).filter((item) => item.status === "scheduled").length, 1);
});

test("stable operation ids make retried task side effects idempotent", () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const followUpId = "22222222-2222-4222-8222-222222222222";
  const notificationId = "33333333-3333-4333-8333-333333333333";
  const input = { id: taskId, title: "Send revised deck", origin: { kind: "manual" } as const, createdBy: "vivid" as const };

  const first = store.createTask(input);
  const replay = store.createTask(input);
  store.createFollowUp({ id: followUpId, taskId, at: 1_800_000_000_000, createdBy: "vivid" });
  store.createFollowUp({ id: followUpId, taskId, at: 1_800_000_000_000, createdBy: "vivid" });
  store.createNotification({ id: notificationId, kind: "tracked", title: "Now tracking", taskId });
  store.createNotification({ id: notificationId, kind: "tracked", title: "Now tracking", taskId });

  assert.equal(first.id, replay.id);
  assert.equal(store.listTasks().filter((item) => item.id === taskId).length, 1);
  assert.equal(store.listFollowUps(taskId).length, 1);
  assert.equal(store.listNotifications().filter((item) => item.id === notificationId).length, 1);
});

test("a follow-up that fired around the due time covers the overdue sweep", () => {
  const dueAt = 1_800_000_000_000;
  const task = store.createTask({
    title: "Invoice to Kestrel",
    dueAt,
    origin: { kind: "manual" },
    createdBy: "you",
  });
  const since = dueAt - 60 * 60 * 1000;
  assert.equal(store.hasFollowUpCovering(task.id, since), false);

  const followUp = store.createFollowUp({ taskId: task.id, at: dueAt, createdBy: "vivid" });
  assert.equal(store.hasFollowUpCovering(task.id, since), true, "scheduled counts");
  assert.equal(store.startFollowUp(followUp.id, dueAt + 5_000), true);
  assert.equal(store.hasFollowUpCovering(task.id, since), true, "running counts");
  assert.equal(store.finishFollowUp(followUp.id, "nudged"), true);
  assert.equal(store.hasFollowUpCovering(task.id, since), true, "fired at the due time counts");
  assert.equal(store.hasFollowUpCovering(task.id, dueAt + 10_000), false, "an older firing does not");

  const stale = store.createFollowUp({ taskId: task.id, at: since - 1, createdBy: "vivid" });
  assert.equal(store.startFollowUp(stale.id, since - 1), true);
  assert.equal(store.finishFollowUp(stale.id, "early nudge"), true);
  assert.equal(store.hasFollowUpCovering(task.id, since), true, "the on-time firing still covers");
});
