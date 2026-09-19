import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://vivid:vivid@127.0.0.1:55433/vivid";
const store = await import("./task-store.ts");

test("a running follow-up preserves the Flue submission needed to resume it", async () => {
  const task = await store.createTask({ title: "Signed NDA from Dami", origin: { kind: "manual" }, createdBy: "you" });
  const followUp = await store.createFollowUp({ taskId: task.id, at: Date.now(), createdBy: "you" });
  assert.equal(await store.startFollowUp(followUp.id, 1_700_000_000_000), true);
  assert.equal(await store.attachFollowUpSubmission(followUp.id, "submission-123"), true);
  const resumable = (await store.listRunningFollowUps()).find((item) => item.id === followUp.id);
  assert.equal(resumable?.submissionId, "submission-123"); assert.equal(resumable?.firedAt, 1_700_000_000_000);
  await store.failFollowUp(followUp.id, "test cleanup");
});

test("a recovered follow-up can only be finalized once", async () => {
  const task = await store.createTask({ title: "Review investor notes", origin: { kind: "manual" }, createdBy: "you" });
  const followUp = await store.createFollowUp({ taskId: task.id, at: Date.now(), createdBy: "you" }); await store.startFollowUp(followUp.id, Date.now());
  assert.equal(await store.finishFollowUp(followUp.id, "First durable result"), true); assert.equal(await store.finishFollowUp(followUp.id, "Duplicate result"), false); assert.equal((await store.getFollowUp(followUp.id))?.output, "First durable result");
});

test("follow-up completion and its notification materialize once", async () => {
  const task = await store.createTask({ title: "Confirm launch date", assignee: "Dami", origin: { kind: "manual" }, createdBy: "you" });
  const followUp = await store.createFollowUp({ taskId: task.id, at: Date.now(), createdBy: "you" }); await store.startFollowUp(followUp.id, Date.now());
  const completion = { output: "Dami still needs to confirm the launch date.", nextFollowUp: { at: 1_900_000_000_000, note: "Keep chasing", repeatEveryMs: 86_400_000, createdBy: "vivid" as const }, notification: { kind: "follow-up" as const, title: "Chased Dami: Confirm launch date", body: "Dami still needs to confirm the launch date.", taskId: task.id, conversationId: task.conversationId } };
  assert.equal(await store.completeFollowUp(followUp.id, completion), true); assert.equal(await store.completeFollowUp(followUp.id, completion), false);
  assert.equal((await store.listNotifications()).filter((item) => item.taskId === task.id).length, 1); assert.equal((await store.listFollowUps(task.id)).filter((item) => item.status === "scheduled").length, 1);
});

test("stable operation ids make retried task side effects idempotent", async () => {
  const taskId = "11111111-1111-4111-8111-111111111111"; const followUpId = "22222222-2222-4222-8222-222222222222"; const notificationId = "33333333-3333-4333-8333-333333333333";
  const input = { id: taskId, title: "Send revised deck", origin: { kind: "manual" } as const, createdBy: "vivid" as const };
  const first = await store.createTask(input); const replay = await store.createTask(input); await store.createFollowUp({ id: followUpId, taskId, at: 1_800_000_000_000, createdBy: "vivid" }); await store.createFollowUp({ id: followUpId, taskId, at: 1_800_000_000_000, createdBy: "vivid" }); await store.createNotification({ id: notificationId, kind: "tracked", title: "Now tracking", taskId }); await store.createNotification({ id: notificationId, kind: "tracked", title: "Now tracking", taskId });
  assert.equal(first.id, replay.id); assert.equal((await store.listTasks()).filter((item) => item.id === taskId).length, 1); assert.equal((await store.listFollowUps(taskId)).length, 1); assert.equal((await store.listNotifications()).filter((item) => item.id === notificationId).length, 1);
});

test("a follow-up that fired around the due time covers the overdue sweep", async () => {
  const dueAt = 1_800_000_000_000; const task = await store.createTask({ title: "Invoice to Kestrel", dueAt, origin: { kind: "manual" }, createdBy: "you" }); const since = dueAt - 60 * 60 * 1000;
  assert.equal(await store.hasFollowUpCovering(task.id, since), false); const followUp = await store.createFollowUp({ taskId: task.id, at: dueAt, createdBy: "vivid" }); assert.equal(await store.hasFollowUpCovering(task.id, since), true); assert.equal(await store.startFollowUp(followUp.id, dueAt + 5_000), true); assert.equal(await store.hasFollowUpCovering(task.id, since), true); assert.equal(await store.finishFollowUp(followUp.id, "nudged"), true); assert.equal(await store.hasFollowUpCovering(task.id, since), true); assert.equal(await store.hasFollowUpCovering(task.id, dueAt + 10_000), false);
  const stale = await store.createFollowUp({ taskId: task.id, at: since - 1, createdBy: "vivid" }); await store.startFollowUp(stale.id, since - 1); await store.finishFollowUp(stale.id, "early nudge"); assert.equal(await store.hasFollowUpCovering(task.id, since), true);
});
