import * as NodeOS from 'node:os'
import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/server',
    environment: 'node',
    // Transformed modules are kept on disk, keyed by content, and reused by the next process.
    fsModuleCache: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
    globalSetup: ['./tests/template.ts'],
    setupFiles: ['./tests/setup.ts'],
    // SQL pools and supervised interpreter cgroups are real resources, independent of Vitest
    // workers. Bound file concurrency so host startup cannot starve another test's receipts:
    // half the machine's cores, between two and six. Every file has a database of its own, so
    // the bound is about processor time, not shared rows. On the eight-core Cloudbox the suite
    // took 226 s at two workers and 134 s at four with the same tests passing (6 Oct 2026, both
    // while other gates ran); six gained little more and eight starved cold child processes.
    maxWorkers: Math.min(6, Math.max(2, Math.floor(NodeOS.availableParallelism() / 2))),
    // Vitest runs project groups with different worker caps only at distinct sequence orders.
    sequence: { groupOrder: 1 },
  },
}

export default defineProject(project)
