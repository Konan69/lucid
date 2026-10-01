import { layer as pgClientLayer } from '@effect/sql-pg/PgClient'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as SqlErrorModule from 'effect/unstable/sql/SqlError'
import { DatabaseConstraintViolation, DatabaseFailure, DatabaseUnavailable } from '@vivid/contracts'
import { EffectPgDatabase, makeWithDefaults as makeDrizzle } from 'drizzle-orm/effect-postgres'
import type { EffectPgQueryEffectHKT, EffectPgQueryResultHKT } from 'drizzle-orm/effect-postgres'
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import type { PgEffectTransaction } from 'drizzle-orm/pg-core/effect/session'
import { ServerConfig } from '../config.ts'

type DriverError = SqlErrorModule.SqlError | EffectDrizzleQueryError
export type DatabaseInfrastructureError =
  | DatabaseUnavailable
  | DatabaseConstraintViolation
  | DatabaseFailure

type DatabaseService = Omit<EffectPgDatabase, 'transaction'> & {
  run: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R>
  transaction: <A, E, R>(
    operation: (
      tx: PgEffectTransaction<EffectPgQueryEffectHKT, EffectPgQueryResultHKT>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R>
}

/**
 * The driver reasons that mean something more specific than "the database failed". Any reason not
 * named here is reported as a plain failure, so a new driver reason is safe by default.
 */
const SQL_REASON_FAILURE: Partial<
  Record<SqlErrorModule.SqlError['reason']['_tag'], () => DatabaseInfrastructureError>
> = {
  ConnectionError: () => new DatabaseUnavailable({ message: 'Database is unavailable' }),
  AuthenticationError: () =>
    new DatabaseFailure({ message: 'Database credentials or permissions are invalid' }),
  AuthorizationError: () =>
    new DatabaseFailure({ message: 'Database credentials or permissions are invalid' }),
  UniqueViolation: () =>
    new DatabaseConstraintViolation({ message: 'Database constraint was violated' }),
  ConstraintError: () =>
    new DatabaseConstraintViolation({ message: 'Database constraint was violated' }),
}

const classifySqlError = (error: SqlErrorModule.SqlError): DatabaseInfrastructureError => {
  const specific = SQL_REASON_FAILURE[error.reason._tag]
  return specific === undefined
    ? new DatabaseFailure({ message: 'Database operation failed' })
    : specific()
}

const isDrizzleQueryError = Schema.is(EffectDrizzleQueryError)

const nestedSqlError = (error: EffectDrizzleQueryError): Option.Option<SqlErrorModule.SqlError> => {
  if (!Cause.isCause(error.cause)) return Option.none()
  const reason = error.cause.reasons.find(Cause.isFailReason)
  if (reason === undefined) return Option.none()
  return Option.liftPredicate(reason.error, SqlErrorModule.isSqlError)
}

const classifyDriverError = (error: DriverError): DatabaseInfrastructureError => {
  if (Predicate.isTagged(error, 'SqlError')) return classifySqlError(error)
  return Option.match(nestedSqlError(error), {
    onNone: () => new DatabaseFailure({ message: 'Database query failed' }),
    onSome: classifySqlError,
  })
}

const mapDriverErrors = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R> => {
  // SAFETY: mapError replaces every DriverError variant and preserves all other success, error, and requirement types.
  return operation.pipe(
    Effect.mapError((error) => {
      if (SqlErrorModule.isSqlError(error)) return classifyDriverError(error)
      if (isDrizzleQueryError(error)) return classifyDriverError(error)
      return error
    }),
  ) as Effect.Effect<A, Exclude<E, DriverError> | DatabaseInfrastructureError, R>
}

export class Database extends Context.Service<Database, DatabaseService>()('vivid/Database') {}

export const databaseLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const postgresLayer = pgClientLayer({
      url: config.DATABASE_URL,
      applicationName: 'vivid-server',
    })
    return Layer.effect(
      Database,
      Effect.gen(function* () {
        const raw = yield* makeDrizzle()
        // SAFETY: Object.create preserves raw as the prototype; this object overrides only run and transaction below.
        const database = Object.create(raw) as DatabaseService
        database.run = mapDriverErrors
        database.transaction = (operation) =>
          mapDriverErrors(raw.transaction((tx) => operation(tx)))
        return database
      }),
    ).pipe(Layer.provide(postgresLayer))
  }),
)

/**
 * The row an `INSERT … RETURNING` or `UPDATE … RETURNING` must have produced. A statement that
 * returns nothing here is a database fault, not an absent record, so it fails instead of handing
 * `undefined` to a decoder.
 */
export const returned = <Row>(rows: ReadonlyArray<Row>, subject: string) => {
  const row = rows[0]
  return row === undefined
    ? Effect.fail(new DatabaseFailure({ message: `${subject} was not returned by the database` }))
    : Effect.succeed(row)
}

/**
 * Builds the decoder for one kind of stored record. Rows are unknown input at this boundary: a
 * column may hold a value an older version wrote, so every read is decoded once here and a row
 * that does not fit is a database fault, never a value handed on half-typed.
 */
export const decodeStored = <A>(schema: Schema.ConstraintDecoder<A>, subject: string) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (value: unknown) =>
    decode(value).pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: `Database returned an invalid ${subject}` }),
      ),
    )
}

/**
 * A record assembled from database columns on its way into a wire schema. Columns are only ever
 * these scalars, so a decoder that takes this cannot be handed an arbitrary object.
 */
export type PersistedFields = Readonly<Record<string, string | number | boolean | null>>
