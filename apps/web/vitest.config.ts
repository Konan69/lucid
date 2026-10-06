import { defineProject } from 'vitest/config'

const project = {
  // The components import each other as `@/ui/...`; resolve it as the app's own build does.
  resolve: { tsconfigPaths: true },
  test: {
    name: '@vivid/web',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
}

export default defineProject(project)
