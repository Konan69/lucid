import { createRequire } from 'node:module'
import { defineProject } from 'vitest/config'

const require = createRequire(import.meta.url)

/** Use Expo's shipped web fetch adapter to exercise real HTTP without a native runtime. */
export default defineProject({
  resolve: {
    alias: {
      'expo/fetch': require.resolve('expo/src/winter/fetch/fetch.web.ts'),
    },
  },
  test: {
    name: '@vivid/mobile',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
