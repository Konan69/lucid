import { defineConfig } from 'vitest/config'

/** These opt-in proofs use the already-running stack and its explicitly supplied disposable
 * database. Ordinary server suites clone databases; a running server cannot follow those clones.
 * Run serially: each scenario owns its Person, Thread, provider resources and one model attempt.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/{code,computers,approvals,connections}/thread.live.test.ts',
      'src/threads/first.live.test.ts',
      'src/memory/outage.live.test.ts',
      'src/computers/held.live.test.ts',
      'src/computers/egress/address.live.test.ts',
      'src/computers/signins/guest.live.test.ts',
      'src/computers/signins/copy.live.test.ts',
      'src/connections/named.live.test.ts',
      'src/connections/another.live.test.ts',
      'src/connections/told.live.test.ts',
      'src/watches/feed.live.test.ts',
      'src/watches/reminder.live.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
})
