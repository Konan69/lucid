import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
    globalSetup: ['./tests/template.ts'],
    setupFiles: ['./tests/setup.ts'],
    // SQL pools and supervised interpreter cgroups are real resources, independent of Vitest
    // workers. Bound file concurrency so host startup cannot starve another test's receipts.
    maxWorkers: 2,
  },
}

export default defineProject(project)
