import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import "./providers/openrouter.ts";
import { Konan } from "./agents/konan.ts";

const app = new Hono();

app.get("/health", (context) =>
  context.json({
    model: process.env.KONAN_MODEL ?? "openrouter/z-ai/glm-5.3-flash",
    service: "konan-agent-runtime",
    status: "ok",
  }),
);

app.use("/agents/konan/*", async (context, next) => {
  const token = process.env.KONAN_RUNTIME_TOKEN;

  if (!token) {
    return context.json({ error: "Runtime token is not configured" }, 503);
  }

  if (context.req.header("authorization") !== `Bearer ${token}`) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

app.route("/agents/konan", createAgentRouter(Konan));

export default app;
