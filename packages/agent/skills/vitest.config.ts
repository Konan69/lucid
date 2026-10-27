import { defineProject } from 'vitest/config'

/** The catalogue reads release assets directly; its tests need no runtime or Markdown plugin. */
export default defineProject({
  test: {
    name: '@vivid/skills',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
