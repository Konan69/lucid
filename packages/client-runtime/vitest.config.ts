import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vivid/client-runtime",
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
  },
});
