import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const runtimeDirectory = fileURLToPath(
  new URL("../../packages/agent-runtime", import.meta.url),
);

export default defineConfig(({ mode }) => {
  const runtimeEnvironment = loadEnv(mode, runtimeDirectory, "");
  const runtimeToken = runtimeEnvironment.KONAN_RUNTIME_TOKEN;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5178,
      proxy: {
        ...Object.fromEntries(
          ["/api/library", "/api/routines", "/api/conversations", "/api/tasks", "/api/follow-ups", "/api/notifications"].map((path) => [
            path,
            {
              target: runtimeEnvironment.KONAN_RUNTIME_URL ?? "http://127.0.0.1:5173",
              changeOrigin: true,
              headers: runtimeToken ? { authorization: `Bearer ${runtimeToken}` } : undefined,
            },
          ]),
        ),
        "/api/vivid": {
          target: runtimeEnvironment.KONAN_RUNTIME_URL ?? "http://127.0.0.1:5173",
          changeOrigin: true,
          headers: runtimeToken
            ? { authorization: `Bearer ${runtimeToken}` }
            : undefined,
          rewrite: (path) => path.replace(/^\/api\/vivid/, "/agents/vivid"),
        },
        "/api/connectors": {
          target: runtimeEnvironment.KONAN_RUNTIME_URL ?? "http://127.0.0.1:5173",
          changeOrigin: true,
          headers: runtimeToken
            ? { authorization: `Bearer ${runtimeToken}` }
            : undefined,
        },
      },
    },
  };
});
