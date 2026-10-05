import * as NodeCrypto from 'node:crypto'
import { and, eq, getTableName } from 'drizzle-orm'
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { Cause, Clock, Effect, Option, Predicate, Schema } from 'effect'
import { Database, decodeStored, returned } from '../../database/client.ts'
import { MachineHeld, MachinePersistenceFailed, MachineKey } from '../machine.ts'
import { machineBindings } from '../tables.ts'
import { CreateRequest, ProviderId, State } from './protocol.ts'

const Stored = Schema.Struct({
  key: MachineKey,
  intent: Schema.String,
  requestedAt: Schema.Int,
  request: CreateRequest,
  providerId: Schema.NullOr(ProviderId),
  observedState: Schema.Union([State, Schema.Literal('intent')]),
  since: Schema.Int,
})
export type Binding = typeof Stored.Type
const decode = decodeStored(Stored, 'Computer machine binding')

/** Inspect the narrow driver error before Database.run discards constraint identity. Pinned
 * @effect/sql-pg internal/sqlError.classifySqlState preserves 23505 as UniqueViolation; Drizzle
 * effect-core wraps it in Cause. The generated product migration leaves this column's UNIQUE
 * unnamed, so PostgreSQL supplies its table_column_key name (verified in the product snapshots).
 * Derive the table/column from Drizzle, and never classify another constraint as ownership. */
const providerConflict = (error: EffectDrizzleQueryError): boolean => {
  if (!Cause.isCause(error.cause)) return false
  return Option.exists(
    Cause.findErrorOption(error.cause),
    (failure) =>
      SqlError.isSqlError(failure) &&
      Predicate.isTagged(failure.reason, 'UniqueViolation') &&
      failure.reason.constraint ===
        `${getTableName(machineBindings)}_${machineBindings.providerId.name}_key`,
  )
}

/** Database authority stays inside the provider. Concurrent servers converge on the winning
 * intent before HTTP, with no network operation inside a transaction. */
export const bindings = Effect.fn('Machine.boat.bindings')(function* () {
  const database = yield* Database
  const load = Effect.fn('Machine.boat.binding.load')(
    function* (key: MachineKey) {
      const rows = yield* database.run(
        database.select().from(machineBindings).where(eq(machineBindings.key, key)).limit(1),
      )
      const row = rows[0]
      return row === undefined ? Option.none<Binding>() : Option.some(yield* decode(row))
    },
    (effect) => effect.pipe(Effect.mapError(() => new MachinePersistenceFailed())),
  )
  /** Provider ids are unique across Persons; return only the decoded row that owns this id. */
  const holder = Effect.fn('Machine.boat.binding.holder')(
    function* (id: ProviderId) {
      const rows = yield* database.run(
        database.select().from(machineBindings).where(eq(machineBindings.providerId, id)).limit(1),
      )
      const row = rows[0]
      return row === undefined ? Option.none<Binding>() : Option.some(yield* decode(row))
    },
    (effect) => effect.pipe(Effect.mapError(() => new MachinePersistenceFailed())),
  )
  const intend = Effect.fn('Machine.boat.binding.intend')(
    function* (key: MachineKey, request: CreateRequest) {
      const now = yield* Clock.currentTimeMillis
      yield* database.run(
        database
          .insert(machineBindings)
          .values({
            key,
            intent: NodeCrypto.randomUUID(),
            requestedAt: now,
            request,
            providerId: null,
            observedState: 'intent',
            since: now,
          })
          .onConflictDoNothing({ target: machineBindings.key }),
      )
      const found = yield* load(key)
      return yield* Option.match(found, {
        onNone: () => Effect.fail(new MachinePersistenceFailed()),
        onSome: Effect.succeed,
      })
    },
    (effect) => effect.pipe(Effect.mapError(() => new MachinePersistenceFailed())),
  )
  const bind = Effect.fn('Machine.boat.binding.bind')(
    function* (key: MachineKey, intent: string, id: ProviderId) {
      const rows = yield* database.run(
        database
          .update(machineBindings)
          .set({ providerId: id })
          .where(and(eq(machineBindings.key, key), eq(machineBindings.intent, intent)))
          .returning()
          .pipe(Effect.mapError((error) => (providerConflict(error) ? new MachineHeld() : error))),
      )
      return yield* decode(yield* returned(rows, 'Computer machine binding'))
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, 'MachineHeld') ? error : new MachinePersistenceFailed(),
        ),
      ),
  )
  /** A transition timestamp means first observed by Vivid, not an invented provider boot time. */
  const observe = Effect.fn('Machine.boat.binding.observe')(
    function* (key: MachineKey, before: Binding, state: typeof State.Type) {
      if (before.observedState === state) return before.since
      const now = yield* Clock.currentTimeMillis
      yield* database.run(
        database
          .update(machineBindings)
          .set({ observedState: state, since: now })
          .where(
            and(
              eq(machineBindings.key, key),
              eq(machineBindings.observedState, before.observedState),
            ),
          ),
      )
      const found = yield* load(key)
      return yield* Option.match(found, {
        onNone: () => Effect.fail(new MachinePersistenceFailed()),
        onSome: (value) => Effect.succeed(value.since),
      })
    },
    (effect) => effect.pipe(Effect.mapError(() => new MachinePersistenceFailed())),
  )
  return { load, holder, intend, bind, observe }
})
export type Bindings = Effect.Success<ReturnType<typeof bindings>>
