import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@vivid/contracts",
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
  },
});
