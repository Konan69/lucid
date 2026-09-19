import { init } from "@flue/runtime";
import { Vivid } from "./agents/vivid.ts";
import {
  attachFollowUpSubmission, completeFollowUp, createFollowUp, createNotification, dueFollowUps,
  failFollowUp, getFollowUp, getTask, hasFollowUpCovering, listRunningFollowUps,
  markTaskOverdueNotified, overdueTasks, startFollowUp, updateFollowUp,
  type FollowUp, type Task,
} from "./task-store.ts";
import { upsertConversation } from "./thread-store.ts";

const TICK_MS = 20_000;
const OVERDUE_GRACE_MS = 60 * 60 * 1000;
type FollowUpSignalAttributes = {
  taskId: string;
  taskTitle: string;
  followUpId: string;
  assignee: string;
  dueAt?: string;
  scheduledAt: string;
};
const inFlight = new Set<string>();
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function describeWhen(value: number | null) { return value === null ? "no due date" : new Date(value).toISOString(); }
function followUpInstruction(task: Task, followUp: FollowUp) {
  return [`A follow-up you scheduled is due for the task "${task.title}".`, task.detail ? `Detail: ${task.detail}` : null, `Waiting on: ${task.assignee ?? "the user (this is their own task)"}.`, `Due: ${describeWhen(task.dueAt)}. Priority: ${task.priority}.`, followUp.note ? `Your note for this follow-up: ${followUp.note}` : null, "Act on it now, in under 120 words:", "1. Say in one line what is outstanding.", "2. If the task waits on someone else, write the exact short, friendly nudge the user can send them.", "3. If the task is the user's own, remind them and propose the single next step.", "4. If the task is clearly finished, call update_task with status \"done\" and say so.", "You cannot contact anyone yourself; do not claim that you did."].filter((line) => line !== null).join("\n");
}

async function executeFollowUp(task: Task, followUp: FollowUp) {
  if (inFlight.has(followUp.id)) return;
  inFlight.add(followUp.id);
  try {
    if (followUp.status === "scheduled") {
      if (!await startFollowUp(followUp.id, Date.now())) return;
      followUp = await getFollowUp(followUp.id) ?? followUp;
    } else if (followUp.status !== "running") return;
    const firedAt = followUp.firedAt ?? Date.now();
    await upsertConversation({ archived: false, id: task.conversationId, title: task.title, preview: `Following up: ${task.title}`, updatedAt: firedAt });
    const agent = init(Vivid, { id: task.conversationId });
    let submissionId = followUp.submissionId;
    if (!submissionId) {
      const attributes: FollowUpSignalAttributes = {
        taskId: task.id,
        taskTitle: task.title,
        followUpId: followUp.id,
        assignee: task.assignee ?? "you",
        scheduledAt: new Date(followUp.at).toISOString(),
      };
      if (task.dueAt) attributes.dueAt = new Date(task.dueAt).toISOString();
      const receipt = await agent.dispatch({
        idempotencyKey: `${followUp.id}:${firedAt}`,
        message: { kind: "signal", type: "follow-up", body: followUpInstruction(task, followUp), attributes },
      });
      submissionId = receipt.submissionId;
      await attachFollowUpSubmission(followUp.id, submissionId);
    }
    const reply = await agent.read(submissionId);
    const current = await getTask(task.id);
    const completion: Parameters<typeof completeFollowUp>[1] = {
      output: reply.text,
      notification: {
        kind: "follow-up",
        title: task.assignee ? `Chased ${task.assignee}: ${task.title}` : `Followed up: ${task.title}`,
        body: reply.text,
        taskId: task.id,
        conversationId: task.conversationId,
      },
    };
    if (followUp.repeatEveryMs && current?.status === "open") {
      completion.nextFollowUp = {
        at: nextOnCadence(followUp.at, followUp.repeatEveryMs, Date.now()),
        note: followUp.note,
        repeatEveryMs: followUp.repeatEveryMs,
        createdBy: followUp.createdBy,
      };
    }
    const completed = await completeFollowUp(followUp.id, completion);
    if (!completed) return;
    await upsertConversation({ archived: false, id: task.conversationId, title: task.title, preview: reply.text.slice(0, 500), updatedAt: Date.now() });
  } catch (error) {
    const message = errorMessage(error).slice(0, 1000);
    if (await failFollowUp(followUp.id, message)) await createNotification({ kind: "follow-up-failed", title: `Could not follow up: ${task.title}`, body: message, taskId: task.id, conversationId: task.conversationId });
  } finally { inFlight.delete(followUp.id); }
}

export async function runFollowUpNow(followUpId: string): Promise<FollowUp | null> {
  const followUp = await getFollowUp(followUpId); const task = followUp ? await getTask(followUp.taskId) : null;
  if (!followUp || !task) return null;
  if (followUp.status === "running" || task.status !== "open") return followUp;
  const runnable = followUp.status === "scheduled" ? followUp : await updateFollowUp(followUp.id, { at: Math.min(followUp.at, Date.now()), status: "scheduled" });
  if (!runnable) return null;
  void executeFollowUp(task, runnable);
  return await getFollowUp(followUpId);
}
export async function chaseTaskNow(task: Task, note: string, createdBy: "you" | "vivid"): Promise<FollowUp> {
  const followUp = await createFollowUp({ taskId: task.id, at: Date.now(), note, createdBy });
  void executeFollowUp(task, followUp); return await getFollowUp(followUp.id) ?? followUp;
}
let ticking = false;
function nextOnCadence(anchor: number, everyMs: number, now: number) { return anchor + (Math.max(0, Math.floor((now - anchor) / everyMs)) + 1) * everyMs; }
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const now = Date.now();
    for (const followUp of await dueFollowUps(now)) {
      const task = await getTask(followUp.taskId); if (!task) continue;
      if (task.status !== "open") { await failFollowUp(followUp.id, "Task is no longer open"); continue; }
      void executeFollowUp(task, followUp);
    }
    for (const task of await overdueTasks(now)) {
      await markTaskOverdueNotified(task.id, now);
      await createNotification({ kind: "overdue", title: `Overdue: ${task.title}`, body: task.assignee ? `Waiting on ${task.assignee} since ${new Date(task.dueAt ?? now).toLocaleDateString()}.` : `Was due ${new Date(task.dueAt ?? now).toLocaleDateString()}.`, taskId: task.id, conversationId: task.conversationId });
      if (!await hasFollowUpCovering(task.id, (task.dueAt ?? now) - OVERDUE_GRACE_MS)) void chaseTaskNow(task, "The task went past its due date without being closed.", "vivid");
    }
  } catch (error) { console.error("[follow-ups] tick failed", error); } finally { ticking = false; }
}
async function recoverRunningFollowUps() {
  for (const followUp of await listRunningFollowUps()) {
    const task = await getTask(followUp.taskId); if (task) void executeFollowUp(task, followUp); else await failFollowUp(followUp.id, "The task for this follow-up no longer exists");
  }
}
setInterval(() => void tick(), TICK_MS).unref();
setTimeout(() => { void recoverRunningFollowUps().then(() => tick()); }, 1500).unref();
