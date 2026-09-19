import { defineProject } from 'vitest/config'

const project = {
  test: {
    name: '@vivid/server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
  },
}

export default defineProject(project)
