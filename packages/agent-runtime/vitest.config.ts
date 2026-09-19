import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vivid/agent-runtime",
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
  },
});
