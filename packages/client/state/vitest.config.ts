import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/state',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
}

export default defineProject(project)
