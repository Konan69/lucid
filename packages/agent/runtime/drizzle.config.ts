import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './memory/schema.ts',
  out: '../../../apps/cells/src/memory/migrations',
})
