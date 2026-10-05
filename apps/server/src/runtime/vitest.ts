import { defineConfig } from 'vitest/config'

/** These opt-in proofs use the already-running stack and its explicitly supplied disposable
 * database. Ordinary server suites clone databases; a running server cannot follow those clones.
 * Run serially: each scenario owns its Person, Thread, provider resources and one model attempt.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/{code,computers,approvals,connections,routines}/thread.live.test.ts',
      'src/threads/first.live.test.ts',
      'src/memory/outage.live.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
})
