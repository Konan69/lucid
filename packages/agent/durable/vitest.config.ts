import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@vivid/durable',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
