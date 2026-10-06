import { flue } from '@flue/vite'
import { defineProject } from 'vitest/config'

const project = {
  // Match the skills test project's public Flue Markdown packaging plugin. The production app
  // imports the real catalog, while server bootstrap and runtime state stay outside this fixture.
  plugins: flue().filter((plugin) => plugin.name === 'flue-markdown-imports'),
  test: {
    name: '@vivid/agent-runtime',
    environment: 'node',
    // Transformed modules are kept on disk, keyed by content, and reused by the next process.
    fsModuleCache: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
    // Worker setup owns database authority; config-time mutation would affect other projects.
    setupFiles: ['./tests/setup.ts'],
  },
}

export default defineProject(project)
