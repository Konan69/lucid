import { fromPool, layerFrom } from "@effect/sql-pg/PgClient"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlErrorModule from "effect/unstable/sql/SqlError"
import {
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable
} from "@vivid/contracts"
import {
  EffectPgDatabase,
  makeWithDefaults as makeDrizzle
} from "drizzle-orm/effect-postgres"
import type {
  EffectPgQueryEffectHKT,
  EffectPgQueryResultHKT
} from "drizzle-orm/effect-postgres"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { PgEffectTransaction } from "drizzle-orm/pg-core/effect/session"
import { Pool } from "pg"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./config.ts"

type DriverError = SqlErrorModule.SqlError | EffectDrizzleQueryError
type DatabaseInfrastructureError =
  | DatabaseUnavailable
  | DatabaseConstraintViolation
  | DatabaseFailure

type DatabaseService = Omit<EffectPgDatabase, "transaction"> & {
  run: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R>
  transaction: <A, E, R>(
    operation: (tx: PgEffectTransaction<EffectPgQueryEffectHKT, EffectPgQueryResultHKT>) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R>
}

const classifySqlError = (error: SqlErrorModule.SqlError): DatabaseInfrastructureError => {
  switch (error.reason._tag) {
    case "ConnectionError":
      return new DatabaseUnavailable({ message: "Database is unavailable" })
    case "AuthenticationError":
    case "AuthorizationError":
      return new DatabaseFailure({ message: "Database credentials or permissions are invalid" })
    case "UniqueViolation":
    case "ConstraintError":
      return new DatabaseConstraintViolation({ message: "Database constraint was violated" })
    default:
      return new DatabaseFailure({ message: "Database operation failed" })
  }
}

const nestedSqlError = (error: EffectDrizzleQueryError): SqlErrorModule.SqlError | undefined => {
  if (!Cause.isCause(error.cause)) return undefined
  const reason = error.cause.reasons.find(Cause.isFailReason)
  const failure = reason?.error
  return SqlErrorModule.isSqlError(failure) ? failure : undefined
}

const classifyDriverError = (error: DriverError): DatabaseInfrastructureError => {
  if (error._tag === "SqlError") return classifySqlError(error)
  const sqlError = nestedSqlError(error)
  return sqlError === undefined
    ? new DatabaseFailure({ message: "Database query failed" })
    : classifySqlError(sqlError)
}

const mapDriverErrors = <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R> => {
  // SAFETY: mapError replaces every DriverError variant and preserves all other success, error, and requirement types.
  return operation.pipe(
    Effect.mapError((error) => {
      if (SqlErrorModule.isSqlError(error)) return classifyDriverError(error)
      if (Schema.is(EffectDrizzleQueryError)(error)) return classifyDriverError(error)
      // SAFETY: the two preceding guards remove both members of DriverError from the generic error union.
      return error as Exclude<E, DriverError>
    })
  ) as Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R>
}

export class Database extends Context.Service<Database, DatabaseService>()("vivid/Database") {}

export const databaseLayer = Layer.unwrap(Effect.gen(function*() {
  const config = yield* ServerConfig
  const pool = new Pool({ connectionString: Redacted.value(config.DATABASE_URL) })
  const pgClientLayer = layerFrom(
    fromPool({
      acquire: Effect.succeed(pool),
      applicationName: "vivid-server"
    })
  )
  return Layer.effect(
    Database,
    Effect.gen(function*() {
      const raw = yield* makeDrizzle()
      // SAFETY: Object.create preserves raw as the prototype; this object overrides only run and transaction below.
      const database = Object.create(raw) as DatabaseService
      database.run = mapDriverErrors
      database.transaction = (operation) => mapDriverErrors(raw.transaction((tx) => operation(tx)))
      return database
    })
  ).pipe(Layer.provide(pgClientLayer))
}))
