import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Docker from "alchemy/Docker"
import type { DeploymentTarget } from "./targets.ts"

export class DatabaseConfigurationError extends Schema.TaggedError<DatabaseConfigurationError>()("DatabaseConfigurationError", {
  variable: Schema.Literal("DATABASE_URL"),
  target: Schema.String,
  message: Schema.String
}, { title: "Database configuration error" }) {}

/** Remote targets bring a database URL; this stack deliberately provisions no hosted database. */
const configuredDatabaseUrl = (target: DeploymentTarget) => Config.redacted("DATABASE_URL").pipe(
  Effect.mapError(() => new DatabaseConfigurationError({
    variable: "DATABASE_URL",
    target: target.key,
    message: `DATABASE_URL is required for the '${target.key}' target`
  }))
)

/**
 * Resolve the one database seam used by migrations and both Node processes.
 * PostgreSQL 18+ images place PGDATA at /var/lib/postgresql/<major>/docker, so the
 * volume mounts the parent directory and survives a major upgrade side by side.
 * Docker props match `alchemy/lib/Docker/{RemoteImage,Volume,Container}.d.ts`.
 */
export const databaseUrlFor = Effect.fn("databaseUrlFor")(function*(target: DeploymentTarget) {
  if (target.database === "required") return yield* configuredDatabaseUrl(target)

  const image = yield* Docker.RemoteImage(target.postgresImageId, {
    name: "postgres",
    tag: "18-alpine",
    alwaysPull: false
  })
  const volume = yield* Docker.Volume("postgres-data", {
    name: target.postgresVolumeName
  })
  yield* Docker.Container("postgres", {
    name: target.postgresContainerName,
    image,
    environment: {
      POSTGRES_DB: "vivid",
      POSTGRES_USER: "vivid",
      POSTGRES_PASSWORD: Redacted.make("vivid")
    },
    ports: [{ external: 55433, internal: 5432 }],
    volumes: [{ hostPath: volume.name, containerPath: "/var/lib/postgresql" }],
    restart: "unless-stopped",
    start: true,
    healthcheck: {
      cmd: ["CMD-SHELL", "pg_isready -U vivid -d vivid"],
      interval: "2 seconds",
      timeout: "3 seconds",
      retries: 20,
      startPeriod: "5 seconds"
    }
  })

  return Redacted.make("postgresql://vivid:vivid@127.0.0.1:55433/vivid")
})
