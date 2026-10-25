import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: '@vivid/state', environment: 'node', include: ['src/**/*.test.ts'] },
})
