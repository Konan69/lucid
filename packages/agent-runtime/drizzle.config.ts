import { defineConfig } from "drizzle-kit";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const databaseUrl = Effect.runSync(Config.Redacted("DATABASE_URL"));

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/runtime-schema.ts",
  out: "./drizzle",
  dbCredentials: { url: Redacted.value(databaseUrl) }
});
