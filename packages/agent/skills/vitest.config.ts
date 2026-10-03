import { flue } from '@flue/vite'
import { defineProject } from 'vitest/config'

/** Flue 2.2.2 flue() returns the real Markdown packaging plugin alongside its server bootstrap.
 * Select just flue-markdown-imports for tests: folders are validated/packaged exactly as in a
 * production build, without starting Flue's HTTP development server or touching its state. */
export default defineProject({
  plugins: flue().filter((plugin) => plugin.name === 'flue-markdown-imports'),
  test: {
    name: '@vivid/skills',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
