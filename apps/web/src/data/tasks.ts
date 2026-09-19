import { Effect, Schema } from "effect";
import { emptyResponse, request, type ClientRequestFailed } from "./request";

export type Program<Value> = Effect.Effect<Value, ClientRequestFailed>;

export type TaskStatus = "open" | "done" | "dropped";
export type TaskPriority = "normal" | "urgent";

export type FollowUp = {
  id: string;
  taskId: string;
  at: number;
  note: string;
  repeatEveryMs: number | null;
  status: "scheduled" | "running" | "fired" | "cancelled" | "failed";
  firedAt: number | null;
  output: string | null;
  error: string | null;
  createdBy: "you" | "vivid";
  createdAt: number;
};

export type Task = {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  dueAt: number | null;
  origin: { kind: "conversation"; conversationId: string } | { kind: "routine"; routineId: string } | { kind: "manual" };
  createdBy: "you" | "vivid";
  conversationId: string;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  followUps: FollowUp[];
  nextFollowUpAt: number | null;
};

export type Notification = {
  id: string;
  kind: "tracked" | "overdue" | "follow-up" | "follow-up-failed";
  title: string;
  body: string;
  taskId: string | null;
  conversationId: string | null;
  createdAt: number;
  readAt: number | null;
};

export type TaskInput = {
  readonly title: string;
  readonly detail: string;
  readonly assignee: string | null;
  readonly dueAt: number | null;
  readonly priority: TaskPriority;
};

export type FollowUpInput = {
  readonly at: number;
  readonly note: string;
  readonly repeatEveryMs: number | null;
};

const FollowUpSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  at: Schema.Number,
  note: Schema.String,
  repeatEveryMs: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["scheduled", "running", "fired", "cancelled", "failed"]),
  firedAt: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdBy: Schema.Literals(["you", "vivid"]),
  createdAt: Schema.Number,
});
const TaskSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  status: Schema.Literals(["open", "done", "dropped"]),
  priority: Schema.Literals(["normal", "urgent"]),
  assignee: Schema.NullOr(Schema.String),
  dueAt: Schema.NullOr(Schema.Number),
  origin: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("conversation"), conversationId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("routine"), routineId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("manual") }),
  ]),
  createdBy: Schema.Literals(["you", "vivid"]),
  conversationId: Schema.String,
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  followUps: Schema.mutable(Schema.Array(FollowUpSchema)),
  nextFollowUpAt: Schema.NullOr(Schema.Number),
});
const NotificationSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["tracked", "overdue", "follow-up", "follow-up-failed"]),
  title: Schema.String,
  body: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  readAt: Schema.NullOr(Schema.Number),
});
const TasksResponseSchema = Schema.fromJsonString(Schema.Struct({
  tasks: Schema.mutable(Schema.Array(TaskSchema)),
}));
const NotificationsResponseSchema = Schema.fromJsonString(Schema.Struct({
  notifications: Schema.mutable(Schema.Array(NotificationSchema)),
}));
const TaskResponseSchema = Schema.fromJsonString(Schema.Struct({ task: TaskSchema }));
const decodeTasksResponse = Schema.decodeUnknownSync(TasksResponseSchema);
const decodeNotificationsResponse = Schema.decodeUnknownSync(NotificationsResponseSchema);
const decodeTaskResponse = Schema.decodeUnknownSync(TaskResponseSchema);

type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

/** Encodes the application-owned JSON request body at the Fetch boundary. */
function json(method: string, body: JsonObject): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Loads the task and notification snapshots shown by Today. */
export const load = Effect.fn("Tasks.load")(function*() {
  const [taskBody, notificationBody] = yield* Effect.all([
    request("/api/tasks", decodeTasksResponse),
    request("/api/notifications", decodeNotificationsResponse),
  ]);
  return { tasks: taskBody.tasks, notifications: notificationBody.notifications };
});

/** Updates one task's open/done state. */
export const setStatus = Effect.fn("Tasks.setStatus")(function*(id: string, status: TaskStatus) {
  yield* request(`/api/tasks/${id}`, emptyResponse, json("PATCH", { status }));
});

/** Marks every current notification read. */
export const markAllNotificationsRead = Effect.fn("Tasks.markAllNotificationsRead")(function*() {
  yield* request("/api/notifications/read", emptyResponse, json("POST", {}));
});

/** Marks one opened notification read without delaying navigation. */
export const markNotificationRead = Effect.fn("Tasks.markNotificationRead")(function*(id: string) {
  yield* request("/api/notifications/read", emptyResponse, json("POST", { ids: [id] }));
});

/** Creates one manual task and an optional first follow-up. */
export const create = Effect.fn("Tasks.create")(function*(input: TaskInput, followUp: FollowUpInput | null) {
  const body = followUp === null ? input : { ...input, followUp };
  const response = yield* request("/api/tasks", decodeTaskResponse, json("POST", body));
  return response.task;
});

/** Updates the editable fields of one task. */
export const update = Effect.fn("Tasks.update")(function*(id: string, input: TaskInput) {
  const response = yield* request(`/api/tasks/${id}`, decodeTaskResponse, json("PATCH", input));
  return response.task;
});

/** Starts Vivid's immediate follow-up for one task. */
export const nudge = Effect.fn("Tasks.nudge")(function*(id: string) {
  yield* request(`/api/tasks/${id}/nudge`, emptyResponse, json("POST", {}));
});

/** Permanently deletes one task and its follow-ups. */
export const remove = Effect.fn("Tasks.remove")(function*(id: string) {
  yield* request(`/api/tasks/${id}`, emptyResponse, { method: "DELETE" });
});

/** Adds one scheduled follow-up to a task. */
export const addFollowUp = Effect.fn("Tasks.addFollowUp")(function*(taskId: string, input: FollowUpInput) {
  yield* request(`/api/tasks/${taskId}/follow-ups`, emptyResponse, json("POST", input));
});

/** Runs one follow-up immediately. */
export const runFollowUp = Effect.fn("Tasks.runFollowUp")(function*(id: string) {
  yield* request(`/api/follow-ups/${id}/run`, emptyResponse, { method: "POST" });
});

/** Cancels one scheduled follow-up. */
export const cancelFollowUp = Effect.fn("Tasks.cancelFollowUp")(function*(id: string) {
  yield* request(`/api/follow-ups/${id}`, emptyResponse, json("PATCH", { status: "cancelled" }));
});

/** Deletes one follow-up. */
export const removeFollowUp = Effect.fn("Tasks.removeFollowUp")(function*(id: string) {
  yield* request(`/api/follow-ups/${id}`, emptyResponse, { method: "DELETE" });
});
