import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/client-runtime',
    environment: 'node',
    // Transformed modules are kept on disk, keyed by content, and reused by the next process.
    fsModuleCache: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
}

export default defineProject(project)
