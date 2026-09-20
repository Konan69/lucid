import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/desktop',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
}

export default defineProject(project)
