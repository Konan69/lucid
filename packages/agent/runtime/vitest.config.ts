import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/agent-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
    // Worker setup owns database authority; config-time mutation would affect other projects.
    setupFiles: ['./tests/setup.ts'],
  },
}

export default defineProject(project)
