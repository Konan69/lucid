import { init } from "@flue/runtime";
import { Vivid } from "./agents/konan.ts";
import {
  attachFollowUpSubmission,
  completeFollowUp,
  createFollowUp,
  createNotification,
  dueFollowUps,
  failFollowUp,
  getFollowUp,
  getTask,
  hasFollowUpCovering,
  listRunningFollowUps,
  markTaskOverdueNotified,
  overdueTasks,
  startFollowUp,
  updateFollowUp,
  type FollowUp,
  type Task,
} from "./task-store.ts";
import { upsertConversation } from "./thread-store.ts";

const TICK_MS = 20_000;
const OVERDUE_GRACE_MS = 60 * 60 * 1000;
const inFlight = new Set<string>();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function describeWhen(value: number | null) {
  return value === null ? "no due date" : new Date(value).toISOString();
}

function followUpInstruction(task: Task, followUp: FollowUp) {
  return [
    `A follow-up you scheduled is due for the task "${task.title}".`,
    task.detail ? `Detail: ${task.detail}` : null,
    `Waiting on: ${task.assignee ?? "the user (this is their own task)"}.`,
    `Due: ${describeWhen(task.dueAt)}. Priority: ${task.priority}.`,
    followUp.note ? `Your note for this follow-up: ${followUp.note}` : null,
    "Act on it now, in under 120 words:",
    "1. Say in one line what is outstanding.",
    "2. If the task waits on someone else, write the exact short, friendly nudge the user can send them.",
    "3. If the task is the user's own, remind them and propose the single next step.",
    "4. If the task is clearly finished, call update_task with status \"done\" and say so.",
    "You cannot contact anyone yourself; do not claim that you did.",
  ].filter((line) => line !== null).join("\n");
}

async function executeFollowUp(task: Task, followUp: FollowUp) {
  if (inFlight.has(followUp.id)) return;
  inFlight.add(followUp.id);
  try {
    if (followUp.status === "scheduled") {
      if (!startFollowUp(followUp.id, Date.now())) return;
      followUp = getFollowUp(followUp.id) ?? followUp;
    } else if (followUp.status !== "running") {
      return;
    }
    const firedAt = followUp.firedAt ?? Date.now();
    upsertConversation({
      archived: false,
      id: task.conversationId,
      title: task.title,
      preview: `Following up: ${task.title}`,
      updatedAt: firedAt,
    });
    const agent = init(Vivid, { id: task.conversationId });
    let submissionId = followUp.submissionId;
    if (!submissionId) {
      const receipt = await agent.dispatch({
        // Per run, not per row: a retried follow-up must be a new submission, or Flue hands back
        // the failed one and the retry fails identically.
        idempotencyKey: `${followUp.id}:${firedAt}`,
        message: {
          kind: "signal",
          type: "follow-up",
          body: followUpInstruction(task, followUp),
          attributes: {
            taskId: task.id,
            taskTitle: task.title,
            followUpId: followUp.id,
            assignee: task.assignee ?? "you",
            ...(task.dueAt ? { dueAt: new Date(task.dueAt).toISOString() } : {}),
            scheduledAt: new Date(followUp.at).toISOString(),
          },
        },
      });
      submissionId = receipt.submissionId;
      attachFollowUpSubmission(followUp.id, submissionId);
    }
    const reply = await agent.read(submissionId);
    const current = getTask(task.id);
    const completed = completeFollowUp(followUp.id, {
      output: reply.text,
      ...(followUp.repeatEveryMs && current?.status === "open"
        ? {
            nextFollowUp: {
              at: nextOnCadence(followUp.at, followUp.repeatEveryMs, Date.now()),
              note: followUp.note,
              repeatEveryMs: followUp.repeatEveryMs,
              createdBy: followUp.createdBy,
            },
          }
        : {}),
      notification: {
        kind: "follow-up",
        title: task.assignee ? `Chased ${task.assignee}: ${task.title}` : `Followed up: ${task.title}`,
        body: reply.text,
        taskId: task.id,
        conversationId: task.conversationId,
      },
    });
    if (!completed) return;
    upsertConversation({
      archived: false,
      id: task.conversationId,
      title: task.title,
      preview: reply.text.slice(0, 500),
      updatedAt: Date.now(),
    });
  } catch (error) {
    const message = errorMessage(error).slice(0, 1000);
    if (failFollowUp(followUp.id, message)) {
      createNotification({
        kind: "follow-up-failed",
        title: `Could not follow up: ${task.title}`,
        body: message,
        taskId: task.id,
        conversationId: task.conversationId,
      });
    }
  } finally {
    inFlight.delete(followUp.id);
  }
}

/** Fires one follow-up immediately, regardless of its scheduled time. */
export function runFollowUpNow(followUpId: string): FollowUp | null {
  const followUp = getFollowUp(followUpId);
  const task = followUp ? getTask(followUp.taskId) : null;
  if (!followUp || !task) return null;
  if (followUp.status === "running") return followUp;
  if (task.status !== "open") return followUp;
  // "Run now" on a row that already fired, failed, or was cancelled is a retry: put it back on the
  // schedule (which clears the old submission) so a fresh signal is dispatched.
  const runnable = followUp.status === "scheduled"
    ? followUp
    : updateFollowUp(followUp.id, { at: Math.min(followUp.at, Date.now()), status: "scheduled" });
  if (!runnable) return null;
  void executeFollowUp(task, runnable);
  return getFollowUp(followUpId);
}

/** Creates an immediate follow-up for a task and fires it. */
export function chaseTaskNow(task: Task, note: string, createdBy: "you" | "vivid"): FollowUp {
  const followUp = createFollowUp({ taskId: task.id, at: Date.now(), note, createdBy });
  void executeFollowUp(task, followUp);
  return getFollowUp(followUp.id) ?? followUp;
}

let ticking = false;

/** First occurrence on the original cadence strictly after `now`, skipping intervals missed while late. */
function nextOnCadence(anchor: number, everyMs: number, now: number): number {
  const missed = Math.max(0, Math.floor((now - anchor) / everyMs));
  return anchor + (missed + 1) * everyMs;
}

function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const followUp of dueFollowUps(now)) {
      const task = getTask(followUp.taskId);
      if (!task) continue;
      if (task.status !== "open") {
        failFollowUp(followUp.id, "Task is no longer open");
        continue;
      }
      void executeFollowUp(task, followUp);
    }
    for (const task of overdueTasks(now)) {
      markTaskOverdueNotified(task.id, now);
      createNotification({
        kind: "overdue",
        title: `Overdue: ${task.title}`,
        body: task.assignee ? `Waiting on ${task.assignee} since ${new Date(task.dueAt ?? now).toLocaleDateString()}.` : `Was due ${new Date(task.dueAt ?? now).toLocaleDateString()}.`,
        taskId: task.id,
        conversationId: task.conversationId,
      });
      // A follow-up that fired around the due time already did the chasing; only step in when nothing did.
      if (!hasFollowUpCovering(task.id, (task.dueAt ?? now) - OVERDUE_GRACE_MS)) {
        chaseTaskNow(task, "The task went past its due date without being closed.", "vivid");
      }
    }
  } catch (error) {
    console.error("[follow-ups] tick failed", error);
  } finally {
    ticking = false;
  }
}

function recoverRunningFollowUps() {
  for (const followUp of listRunningFollowUps()) {
    const task = getTask(followUp.taskId);
    if (task) void executeFollowUp(task, followUp);
    else failFollowUp(followUp.id, "The task for this follow-up no longer exists");
  }
}

setInterval(tick, TICK_MS).unref();
setTimeout(() => {
  recoverRunningFollowUps();
  tick();
}, 1500).unref();
