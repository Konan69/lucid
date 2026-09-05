import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import "./providers/openrouter.ts";
import { Vivid } from "./agents/konan.ts";
import {
  LIBRARY_FILE_TYPES,
  MAX_LIBRARY_FILE_BYTES,
  digestBytes,
  ingestLibraryDocument,
} from "./library-ingest.ts";
import {
  createLibraryFolder,
  createLibraryDocument,
  deleteLibraryFolder,
  deleteLibraryDocument,
  getLibraryFolder,
  getLibraryDocument,
  getLibraryDocumentByDigest,
  getStoredLibraryDocument,
  getStoredLibraryDocumentByName,
  listAllLibraryFolders,
  listLibraryDocuments,
  listLibraryFolders,
  searchLibrary,
  updateLibraryDocument,
  updateLibraryFolder,
} from "./library-store.ts";
import {
  GmailConnector,
  CalendarConnector,
  DriveConnector,
  getConnectorStatus,
  deleteCredentialsForConnector,
} from "@konan/connectors";
import {
  getRoutineView,
  listRoutineViews,
  removeRoutineJob,
  runRoutineNow,
  syncRoutineJob,
  validateRoutineSchedule,
} from "./routine-scheduler.ts";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  updateRoutine,
} from "./routine-store.ts";
import { chaseTaskNow, runFollowUpNow } from "./follow-up-scheduler.ts";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  createFollowUp,
  createTask,
  deleteFollowUp,
  deleteTask,
  getFollowUp,
  getTask,
  getTaskView,
  listNotifications,
  listTaskViews,
  markNotificationsRead,
  unreadNotificationCount,
  updateFollowUp,
  updateTask,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from "./task-store.ts";
import { deleteConversation, listConversations, upsertConversation } from "./thread-store.ts";

const app = new Hono();

app.get("/health", (context) =>
  context.json({
    model: process.env.KONAN_MODEL ?? "openrouter/z-ai/glm-5.3-flash",
    service: "vivid-agent-runtime",
    status: "ok",
  }),
);

const requireRuntimeToken = async (context: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
  const token = process.env.KONAN_RUNTIME_TOKEN;

  if (!token) {
    return context.json({ error: "Runtime token is not configured" }, 503);
  }

  if (context.req.header("authorization") !== `Bearer ${token}`) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  return next();
};

app.use("/agents/vivid/*", requireRuntimeToken);
app.use("/api/conversations", requireRuntimeToken);
app.use("/api/conversations/*", requireRuntimeToken);
app.use("/api/routines", requireRuntimeToken);
app.use("/api/routines/*", requireRuntimeToken);
app.use("/api/library", requireRuntimeToken);
app.use("/api/library/*", requireRuntimeToken);
app.use("/api/tasks", requireRuntimeToken);
app.use("/api/tasks/*", requireRuntimeToken);
app.use("/api/follow-ups/*", requireRuntimeToken);
app.use("/api/notifications", requireRuntimeToken);
app.use("/api/notifications/*", requireRuntimeToken);

app.get("/api/conversations", (context) =>
  context.json({ conversations: listConversations() }),
);

app.put("/api/conversations/:id", async (context) => {
  const id = context.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return context.json({ error: "Invalid conversation id" }, 400);
  }

  const body = await context.req.json<{
    archived?: unknown;
    preview?: unknown;
    title?: unknown;
    updatedAt?: unknown;
  }>();
  if (typeof body.title !== "string" || typeof body.preview !== "string") {
    return context.json({ error: "title and preview must be strings" }, 400);
  }

  const conversation = upsertConversation({
    archived: typeof body.archived === "boolean" ? body.archived : false,
    id,
    title: body.title.trim().slice(0, 120) || "New conversation",
    preview: body.preview.trim().slice(0, 500),
    updatedAt: typeof body.updatedAt === "number" && Number.isFinite(body.updatedAt)
      ? Math.trunc(body.updatedAt)
      : Date.now(),
  });

  return context.json({ conversation });
});

app.patch("/api/conversations/:id", async (context) => {
  const id = context.req.param("id");
  const current = listConversations().find((conversation) => conversation.id === id);
  if (!current) return context.json({ error: "Conversation not found" }, 404);
  const body = await context.req.json<{ archived?: unknown; title?: unknown }>();
  if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
    return context.json({ error: "Invalid title" }, 400);
  }
  if (body.archived !== undefined && typeof body.archived !== "boolean") {
    return context.json({ error: "Invalid archived value" }, 400);
  }
  const conversation = upsertConversation({
    ...current,
    title: typeof body.title === "string" ? body.title.trim().slice(0, 120) : current.title,
    archived: typeof body.archived === "boolean" ? body.archived : current.archived,
    updatedAt: Date.now(),
  });
  return context.json({ conversation });
});

app.delete("/api/conversations/:id", (context) => {
  if (!deleteConversation(context.req.param("id"))) {
    return context.json({ error: "Conversation not found" }, 404);
  }
  return context.body(null, 204);
});

app.get("/api/library", (context) => {
  const folderId = context.req.query("folderId") ?? null;
  if (folderId && !getLibraryFolder(folderId)) return context.json({ error: "Folder not found" }, 404);
  return context.json({ documents: listLibraryDocuments(folderId), folders: listLibraryFolders(folderId) });
});

app.post("/api/library/folders", async (context) => {
  const body = await context.req.json<{ name?: unknown; parentId?: unknown }>();
  if (typeof body.name !== "string" || !body.name.trim()) return context.json({ error: "Folder name is required" }, 400);
  const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
  if (parentId && !getLibraryFolder(parentId)) return context.json({ error: "Parent folder not found" }, 404);
  return context.json({ folder: createLibraryFolder(body.name.trim().slice(0, 120), parentId) }, 201);
});

app.get("/api/library/folders", (context) =>
  context.json({ folders: listAllLibraryFolders() }),
);

app.patch("/api/library/folders/:id", async (context) => {
  const body = await context.req.json<{ name?: unknown; parentId?: unknown }>();
  const patch: { name?: string; parentId?: string | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return context.json({ error: "Folder name is required" }, 400);
    patch.name = body.name.trim().slice(0, 120);
  }
  if (body.parentId !== undefined) {
    if (body.parentId !== null && typeof body.parentId !== "string") return context.json({ error: "Invalid parent folder" }, 400);
    patch.parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
    if (patch.parentId && !getLibraryFolder(patch.parentId)) return context.json({ error: "Parent folder not found" }, 404);
  }
  try {
    const folder = updateLibraryFolder(context.req.param("id"), patch);
    return folder ? context.json({ folder }) : context.json({ error: "Folder not found" }, 404);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : "Could not update folder" }, 409);
  }
});

app.delete("/api/library/folders/:id", (context) => {
  const outcome = deleteLibraryFolder(context.req.param("id"));
  if (outcome === "not-found") return context.json({ error: "Folder not found" }, 404);
  if (outcome === "not-empty") return context.json({ error: "Folder must be empty before it can be deleted" }, 409);
  return context.body(null, 204);
});

app.post("/api/library", async (context) => {
  const form = await context.req.formData();
  const upload = form.get("file");
  if (!(upload instanceof File)) return context.json({ error: "A file is required" }, 400);
  if (upload.size === 0) return context.json({ error: "The file is empty" }, 400);
  if (upload.size > MAX_LIBRARY_FILE_BYTES) return context.json({ error: "Files must be 10 MB or smaller" }, 413);

  const name = (upload.name.split(/[\\/]/).pop() ?? "document").trim().slice(0, 180);
  const extension = name.toLocaleLowerCase().split(".").pop();
  const inferredType = extension === "pdf" ? "application/pdf" : extension === "md" || extension === "markdown" ? "text/markdown" : extension === "txt" ? "text/plain" : upload.type;
  const mimeType = LIBRARY_FILE_TYPES.includes(inferredType as typeof LIBRARY_FILE_TYPES[number]) ? inferredType : "";
  if (!mimeType) return context.json({ error: "Only PDF, Markdown, and plain-text files are supported" }, 415);
  const requestedFolderId = form.get("folderId");
  const folderId = typeof requestedFolderId === "string" && requestedFolderId ? requestedFolderId : null;
  if (folderId && !getLibraryFolder(folderId)) return context.json({ error: "Folder not found" }, 404);

  const bytes = new Uint8Array(await upload.arrayBuffer());
  const sha256 = digestBytes(bytes);
  const existing = getLibraryDocumentByDigest(sha256);
  if (existing) return context.json({ document: existing, duplicate: true });

  const document = createLibraryDocument({ name, mimeType, bytes, sha256, folderId });
  void ingestLibraryDocument(document.id);
  return context.json({ document, duplicate: false }, 202);
});

app.post("/api/library/search", async (context) => {
  const body = await context.req.json<{ folderId?: unknown; limit?: unknown; query?: unknown }>();
  if (typeof body.query !== "string" || body.query.trim().length < 2) {
    return context.json({ error: "A search query is required" }, 400);
  }
  const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? body.limit : 6;
  const folderId = typeof body.folderId === "string" && body.folderId ? body.folderId : undefined;
  if (folderId && !getLibraryFolder(folderId)) return context.json({ error: "Folder not found" }, 404);
  return context.json({ results: searchLibrary(body.query.trim().slice(0, 500), limit, folderId) });
});

app.get("/api/library/source", (context) => {
  const name = context.req.query("name");
  if (!name) return context.json({ error: "Source name is required" }, 400);
  const document = getStoredLibraryDocumentByName(name);
  if (!document) return context.json({ error: "Document not found" }, 404);
  return new Response(document.bytes, {
    headers: {
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      "content-length": String(document.size),
      "content-type": document.mimeType,
      "x-content-type-options": "nosniff",
    },
  });
});

app.get("/api/library/:id/content", (context) => {
  const document = getStoredLibraryDocument(context.req.param("id"));
  if (!document) return context.json({ error: "Document not found" }, 404);
  return new Response(document.bytes, {
    headers: {
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      "content-length": String(document.size),
      "content-type": document.mimeType,
      "x-content-type-options": "nosniff",
    },
  });
});

app.get("/api/library/:id", (context) => {
  const document = getLibraryDocument(context.req.param("id"));
  return document ? context.json({ document }) : context.json({ error: "Document not found" }, 404);
});

app.patch("/api/library/:id", async (context) => {
  const body = await context.req.json<{ folderId?: unknown; name?: unknown }>();
  const patch: { name?: string; folderId?: string | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return context.json({ error: "File name is required" }, 400);
    patch.name = body.name.trim().slice(0, 180);
  }
  if (body.folderId !== undefined) {
    if (body.folderId !== null && typeof body.folderId !== "string") return context.json({ error: "Invalid folder" }, 400);
    patch.folderId = typeof body.folderId === "string" && body.folderId ? body.folderId : null;
    if (patch.folderId && !getLibraryFolder(patch.folderId)) return context.json({ error: "Folder not found" }, 404);
  }
  const document = updateLibraryDocument(context.req.param("id"), patch);
  return document ? context.json({ document }) : context.json({ error: "Document not found" }, 404);
});

app.delete("/api/library/:id", (context) => {
  return deleteLibraryDocument(context.req.param("id"))
    ? context.body(null, 204)
    : context.json({ error: "Document not found" }, 404);
});

app.get("/api/routines", (context) =>
  context.json({ routines: listRoutineViews() }),
);

app.post("/api/routines", async (context) => {
  const body = await context.req.json<{
    cron?: unknown;
    name?: unknown;
    prompt?: unknown;
    timezone?: unknown;
    libraryFolderId?: unknown;
  }>();
  if (
    typeof body.name !== "string" || typeof body.prompt !== "string" ||
    typeof body.cron !== "string" || typeof body.timezone !== "string"
  ) {
    return context.json({ error: "name, prompt, cron, and timezone are required" }, 400);
  }
  const input = {
    name: body.name.trim().slice(0, 120),
    prompt: body.prompt.trim().slice(0, 4000),
    cron: body.cron.trim().slice(0, 120),
    timezone: body.timezone.trim().slice(0, 120),
    libraryFolderId: typeof body.libraryFolderId === "string" && body.libraryFolderId ? body.libraryFolderId : null,
  };
  if (!input.name || !input.prompt || !input.cron || !input.timezone) {
    return context.json({ error: "Routine fields cannot be empty" }, 400);
  }
  if (input.libraryFolderId && !getLibraryFolder(input.libraryFolderId)) {
    return context.json({ error: "Library folder not found" }, 404);
  }
  try {
    validateRoutineSchedule(input.cron, input.timezone);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400);
  }
  const routine = createRoutine(input);
  syncRoutineJob(routine);
  return context.json({ routine: getRoutineView(routine) }, 201);
});

app.patch("/api/routines/:id", async (context) => {
  const current = getRoutine(context.req.param("id"));
  if (!current) return context.json({ error: "Routine not found" }, 404);
  const body = await context.req.json<{
    cron?: unknown;
    enabled?: unknown;
    name?: unknown;
    prompt?: unknown;
    timezone?: unknown;
    libraryFolderId?: unknown;
  }>();
  const patch: Parameters<typeof updateRoutine>[1] = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return context.json({ error: "Invalid name" }, 400);
    patch.name = body.name.trim().slice(0, 120);
  }
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string" || !body.prompt.trim()) return context.json({ error: "Invalid prompt" }, 400);
    patch.prompt = body.prompt.trim().slice(0, 4000);
  }
  if (body.cron !== undefined) {
    if (typeof body.cron !== "string" || !body.cron.trim()) return context.json({ error: "Invalid cron" }, 400);
    patch.cron = body.cron.trim().slice(0, 120);
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || !body.timezone.trim()) return context.json({ error: "Invalid timezone" }, 400);
    patch.timezone = body.timezone.trim().slice(0, 120);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return context.json({ error: "Invalid enabled value" }, 400);
    patch.enabled = body.enabled;
  }
  if (body.libraryFolderId !== undefined) {
    if (body.libraryFolderId !== null && typeof body.libraryFolderId !== "string") return context.json({ error: "Invalid Library folder" }, 400);
    patch.libraryFolderId = typeof body.libraryFolderId === "string" && body.libraryFolderId ? body.libraryFolderId : null;
    if (patch.libraryFolderId && !getLibraryFolder(patch.libraryFolderId)) return context.json({ error: "Library folder not found" }, 404);
  }
  try {
    validateRoutineSchedule(patch.cron ?? current.cron, patch.timezone ?? current.timezone);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400);
  }
  const routine = updateRoutine(current.id, patch);
  if (!routine) return context.json({ error: "Routine not found" }, 404);
  syncRoutineJob(routine);
  return context.json({ routine: getRoutineView(routine) });
});

app.delete("/api/routines/:id", (context) => {
  const id = context.req.param("id");
  if (!deleteRoutine(id)) return context.json({ error: "Routine not found" }, 404);
  removeRoutineJob(id);
  return context.body(null, 204);
});

app.post("/api/routines/:id/run", (context) => {
  const routine = getRoutine(context.req.param("id"));
  if (!routine) return context.json({ error: "Routine not found" }, 404);
  const run = runRoutineNow(routine);
  return context.json({ run }, 202);
});

// Connector routes
const connectors: Record<string, () => GmailConnector | CalendarConnector | DriveConnector> = {
  gmail: () => new GmailConnector(),
  calendar: () => new CalendarConnector(),
  drive: () => new DriveConnector(),
};

app.use("/api/connectors", requireRuntimeToken);
app.use("/api/connectors/*", requireRuntimeToken);

app.get("/api/connectors", (context) => {
  const status = Object.keys(connectors).map((id) => ({
    id,
    status: getConnectorStatus(id as "gmail" | "calendar" | "drive"),
    metadata: connectors[id]!().metadata(),
  }));
  return context.json({ connectors: status });
});

app.get("/api/connectors/:id/auth", (context) => {
  const id = context.req.param("id");
  const factory = connectors[id];
  if (!factory) return context.json({ error: "Unknown connector" }, 404);

  const state = JSON.stringify({ connector: id, nonce: crypto.randomUUID() });
  try {
    const authUrl = factory().getAuthUrl(Buffer.from(state).toString("base64url"));
    return context.json({ authUrl });
  } catch {
    return context.json({ error: "Google sign-in is not configured on this Vivid server yet." }, 503);
  }
});

app.get("/api/connectors/google/callback", async (context) => {
  const code = context.req.query("code");
  const stateParam = context.req.query("state");
  if (!code) return context.json({ error: "Missing code" }, 400);

  let connectorId = "gmail";
  try {
    if (stateParam) {
      const decoded = JSON.parse(Buffer.from(stateParam, "base64url").toString("utf-8")) as { connector?: string };
      if (decoded.connector && connectors[decoded.connector]) {
        connectorId = decoded.connector;
      }
    }
  } catch {
    // Fall back to default connector if state is malformed.
  }

  // Google lands the browser here through the web dev proxy, so send it back to the Connectors
  // screen with the outcome instead of showing raw JSON.
  try {
    const connector = connectors[connectorId]!();
    const credential = await connector.exchangeCode(code);
    return context.redirect(`/?settings=connectors&connected=${encodeURIComponent(credential.connectorId)}`, 303);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "OAuth failed";
    return context.redirect(`/?settings=connectors&error=${encodeURIComponent(reason)}`, 303);
  }
});

app.delete("/api/connectors/:id", (context) => {
  const id = context.req.param("id");
  if (!connectors[id]) return context.json({ error: "Unknown connector" }, 404);
  const deleted = deleteCredentialsForConnector(id as "gmail" | "calendar" | "drive");
  return context.json({ success: true, deleted });
});

const MAX_REPEAT_MS = 366 * 86_400_000;

/** Accepts epoch milliseconds or an ISO 8601 string; `null` clears. Returns `undefined` when absent. */
function parseWhen(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return "invalid";
}

function optionalText(value: unknown, max: number): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim().slice(0, max) : "invalid";
}

function taskPatchFrom(body: Record<string, unknown>): TaskPatch | string {
  const patch: TaskPatch = {};
  const title = optionalText(body.title, 200);
  if (title === "invalid" || title === "") return "Title is required";
  if (title !== undefined) patch.title = title;
  const detail = optionalText(body.detail, 2000);
  if (detail === "invalid") return "Invalid detail";
  if (detail !== undefined) patch.detail = detail;
  if (body.assignee !== undefined) {
    if (body.assignee !== null && typeof body.assignee !== "string") return "Invalid assignee";
    patch.assignee = typeof body.assignee === "string" && body.assignee.trim() ? body.assignee.trim().slice(0, 80) : null;
  }
  const dueAt = parseWhen(body.dueAt);
  if (dueAt === "invalid") return "Invalid due date";
  if (dueAt !== undefined) patch.dueAt = dueAt;
  if (body.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(body.priority as TaskPriority)) return "Invalid priority";
    patch.priority = body.priority as TaskPriority;
  }
  if (body.status !== undefined) {
    if (!TASK_STATUSES.includes(body.status as TaskStatus)) return "Invalid status";
    patch.status = body.status as TaskStatus;
  }
  return patch;
}

function followUpInputFrom(body: Record<string, unknown>): { at?: number; note?: string; repeatEveryMs?: number | null } | string {
  const input: { at?: number; note?: string; repeatEveryMs?: number | null } = {};
  const at = parseWhen(body.at);
  if (at === "invalid" || at === null) return "A follow-up time is required";
  if (at !== undefined) input.at = at;
  const note = optionalText(body.note, 500);
  if (note === "invalid") return "Invalid note";
  if (note !== undefined) input.note = note;
  const repeat = body.repeatEveryMs;
  if (repeat !== undefined) {
    if (repeat !== null && (typeof repeat !== "number" || !Number.isSafeInteger(repeat) || repeat < 60_000 || repeat > MAX_REPEAT_MS)) return "Repeat must be between one minute and one year";
    input.repeatEveryMs = repeat;
  }
  return input;
}

app.get("/api/tasks", (context) => {
  const status = context.req.query("status");
  if (status !== undefined && !TASK_STATUSES.includes(status as TaskStatus)) return context.json({ error: "Invalid status" }, 400);
  return context.json({ tasks: listTaskViews(status as TaskStatus | undefined) });
});

app.post("/api/tasks", async (context) => {
  const body = await context.req.json<Record<string, unknown>>();
  const patch = taskPatchFrom(body);
  if (typeof patch === "string") return context.json({ error: patch }, 400);
  if (!patch.title) return context.json({ error: "Title is required" }, 400);
  const followUpBody = body.followUp;
  const followUp = followUpBody === undefined || followUpBody === null ? undefined : followUpInputFrom(followUpBody as Record<string, unknown>);
  if (typeof followUp === "string") return context.json({ error: followUp }, 400);
  if (followUp && followUp.at === undefined) return context.json({ error: "A follow-up time is required" }, 400);
  const task = createTask({
    title: patch.title,
    detail: patch.detail,
    assignee: patch.assignee,
    dueAt: patch.dueAt,
    priority: patch.priority,
    origin: { kind: "manual" },
    createdBy: "you",
  });
  if (followUp?.at !== undefined) createFollowUp({ taskId: task.id, at: followUp.at, note: followUp.note, repeatEveryMs: followUp.repeatEveryMs, createdBy: "you" });
  return context.json({ task: getTaskView(task) }, 201);
});

app.patch("/api/tasks/:id", async (context) => {
  const body = await context.req.json<Record<string, unknown>>();
  const patch = taskPatchFrom(body);
  if (typeof patch === "string") return context.json({ error: patch }, 400);
  const task = updateTask(context.req.param("id"), patch);
  return task ? context.json({ task: getTaskView(task) }) : context.json({ error: "Task not found" }, 404);
});

app.delete("/api/tasks/:id", (context) => {
  return deleteTask(context.req.param("id")) ? context.body(null, 204) : context.json({ error: "Task not found" }, 404);
});

app.post("/api/tasks/:id/nudge", async (context) => {
  const task = getTask(context.req.param("id"));
  if (!task) return context.json({ error: "Task not found" }, 404);
  if (task.status !== "open") return context.json({ error: "Only open tasks can be chased" }, 409);
  const body = await context.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const note = optionalText(body.note, 500);
  const followUp = chaseTaskNow(task, note && note !== "invalid" ? note : "You asked Vivid to chase this now.", "you");
  return context.json({ followUp, task: getTaskView(task) }, 202);
});

app.post("/api/tasks/:id/follow-ups", async (context) => {
  const task = getTask(context.req.param("id"));
  if (!task) return context.json({ error: "Task not found" }, 404);
  if (task.status !== "open") return context.json({ error: "Reopen the task before scheduling a follow-up" }, 409);
  const input = followUpInputFrom(await context.req.json<Record<string, unknown>>());
  if (typeof input === "string") return context.json({ error: input }, 400);
  if (input.at === undefined) return context.json({ error: "A follow-up time is required" }, 400);
  const followUp = createFollowUp({ taskId: task.id, at: input.at, note: input.note, repeatEveryMs: input.repeatEveryMs, createdBy: "you" });
  return context.json({ followUp, task: getTaskView(task) }, 201);
});

app.patch("/api/follow-ups/:id", async (context) => {
  const current = getFollowUp(context.req.param("id"));
  if (!current) return context.json({ error: "Follow-up not found" }, 404);
  const body = await context.req.json<Record<string, unknown>>();
  const input = followUpInputFrom(body);
  if (typeof input === "string") return context.json({ error: input }, 400);
  let status: "scheduled" | "cancelled" | undefined;
  if (body.status !== undefined) {
    if (body.status !== "scheduled" && body.status !== "cancelled") return context.json({ error: "A follow-up can only be rescheduled or cancelled" }, 400);
    status = body.status;
  }
  if (current.status === "running") return context.json({ error: "This follow-up is running right now" }, 409);
  const followUp = updateFollowUp(current.id, { ...input, status: status ?? (input.at !== undefined && current.status !== "scheduled" ? "scheduled" : undefined) });
  const task = followUp ? getTask(followUp.taskId) : null;
  return followUp && task ? context.json({ followUp, task: getTaskView(task) }) : context.json({ error: "Follow-up not found" }, 404);
});

app.delete("/api/follow-ups/:id", (context) => {
  return deleteFollowUp(context.req.param("id")) ? context.body(null, 204) : context.json({ error: "Follow-up not found" }, 404);
});

app.post("/api/follow-ups/:id/run", (context) => {
  const followUp = runFollowUpNow(context.req.param("id"));
  if (!followUp) return context.json({ error: "Follow-up not found" }, 404);
  const task = getTask(followUp.taskId);
  return context.json({ followUp, task: task ? getTaskView(task) : null }, 202);
});

app.get("/api/notifications", (context) =>
  context.json({ notifications: listNotifications(), unreadCount: unreadNotificationCount() }),
);

app.post("/api/notifications/read", async (context) => {
  const body = await context.req.json<{ ids?: unknown }>().catch(() => ({} as { ids?: unknown }));
  if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string"))) {
    return context.json({ error: "Invalid notification ids" }, 400);
  }
  const changed = markNotificationsRead(body.ids as string[] | undefined);
  return context.json({ changed, unreadCount: unreadNotificationCount() });
});

app.route("/agents/vivid", createAgentRouter(Vivid));

export default app;
