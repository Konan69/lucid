import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@vivid/durable',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The crash and recovery cases start real Node processes, kill them and start them again,
    // and the storage cases open a real PostgreSQL. Each waits on a typed signal (the child's
    // first line, its exit, a stream chunk), never on a clock, but a process start has no bound
    // on a busy machine: `conformance/crashing.test.ts` passed alone and exceeded Vitest's 5 s
    // default under the whole gate (7 Oct 2026, load 27 on 16 cores). This is the failure bound
    // for a case that hangs, the same one `apps/desktop` uses for its process tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
