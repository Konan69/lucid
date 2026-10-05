import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/desktop',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    // The Computer tests start real child processes whose stand-in loads its modules cold
    // (about a second), and this machine runs several lanes at once; the default 5 s test and
    // 10 s hook budgets flake under that load though nothing is wrong. These are ceilings, not
    // waits: no test here sleeps.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
}
export default project
