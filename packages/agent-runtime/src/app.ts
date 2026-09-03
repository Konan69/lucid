import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import "./providers/openrouter.ts";
import { Konan } from "./agents/konan.ts";
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

app.route("/agents/konan", createAgentRouter(Konan));

export default app;
