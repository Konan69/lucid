import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
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
    // These suites import the runtime's Vivid, and the runtime does not load without its notes
    // directory (`packages/agent/runtime/src/notes.ts`). Nothing is written there unless a case
    // writes a note; the directory is the system's temporary one, never a developer's notes.
    env: { VIVID_MEMORY_DIR: NodePath.join(NodeOS.tmpdir(), 'vivid-skills-test-notes') },
    include: ['src/**/*.test.ts'],
  },
})
