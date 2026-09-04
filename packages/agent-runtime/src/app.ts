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
  listLibraryDocuments,
  listLibraryFolders,
  searchLibrary,
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
  const body = await context.req.json<{ limit?: unknown; query?: unknown }>();
  if (typeof body.query !== "string" || body.query.trim().length < 2) {
    return context.json({ error: "A search query is required" }, 400);
  }
  const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? body.limit : 6;
  return context.json({ results: searchLibrary(body.query.trim().slice(0, 500), limit) });
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
  };
  if (!input.name || !input.prompt || !input.cron || !input.timezone) {
    return context.json({ error: "Routine fields cannot be empty" }, 400);
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
  const authUrl = factory().getAuthUrl(Buffer.from(state).toString("base64url"));
  return context.json({ authUrl });
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

  try {
    const connector = connectors[connectorId]!();
    const credential = await connector.exchangeCode(code);
    return context.json({ success: true, connectorId: credential.connectorId, credentialId: credential.id });
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : "OAuth failed" }, 500);
  }
});

app.delete("/api/connectors/:id", (context) => {
  const id = context.req.param("id");
  if (!connectors[id]) return context.json({ error: "Unknown connector" }, 404);
  const deleted = deleteCredentialsForConnector(id as "gmail" | "calendar" | "drive");
  return context.json({ success: true, deleted });
});

app.route("/agents/vivid", createAgentRouter(Vivid));

export default app;
