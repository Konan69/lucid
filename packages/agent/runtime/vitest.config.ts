import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@vivid/agent-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Worker setup settles what a worker may reach before any module reads configuration.
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/template.ts'],
  },
})
