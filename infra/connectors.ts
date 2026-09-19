import { defineConfig } from "drizzle-kit"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Migration-only config; connector schema generation remains a separate dev-time operation. */
const databaseUrl = Effect.runSync(Config.redacted("DATABASE_URL"))
const infrastructureDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  dialect: "postgresql",
  out: resolve(infrastructureDirectory, "connectors"),
  dbCredentials: { url: Redacted.value(databaseUrl) }
})
