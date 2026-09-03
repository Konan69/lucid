import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import "./providers/openrouter.ts";
import { Konan } from "./agents/konan.ts";
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
import { listConversations, upsertConversation } from "./thread-store.ts";

const app = new Hono();

app.get("/health", (context) =>
  context.json({
    model: process.env.KONAN_MODEL ?? "openrouter/z-ai/glm-5.3-flash",
    service: "konan-agent-runtime",
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

app.use("/agents/konan/*", requireRuntimeToken);
app.use("/api/conversations", requireRuntimeToken);
app.use("/api/conversations/*", requireRuntimeToken);
app.use("/api/routines", requireRuntimeToken);
app.use("/api/routines/*", requireRuntimeToken);

app.get("/api/conversations", (context) =>
  context.json({ conversations: listConversations() }),
);

app.put("/api/conversations/:id", async (context) => {
  const id = context.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return context.json({ error: "Invalid conversation id" }, 400);
  }

  const body = await context.req.json<{
    preview?: unknown;
    title?: unknown;
    updatedAt?: unknown;
  }>();
  if (typeof body.title !== "string" || typeof body.preview !== "string") {
    return context.json({ error: "title and preview must be strings" }, 400);
  }

  const conversation = upsertConversation({
    id,
    title: body.title.trim().slice(0, 120) || "New conversation",
    preview: body.preview.trim().slice(0, 500),
    updatedAt: typeof body.updatedAt === "number" && Number.isFinite(body.updatedAt)
      ? Math.trunc(body.updatedAt)
      : Date.now(),
  });

  return context.json({ conversation });
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

app.route("/agents/konan", createAgentRouter(Konan));

export default app;
