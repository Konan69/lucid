import { defineConfig } from 'drizzle-kit'

const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for product migrations')

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/product.ts',
  out: './product-drizzle',
  dbCredentials: { url: databaseUrl },
})
