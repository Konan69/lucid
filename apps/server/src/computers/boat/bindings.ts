import * as NodeCrypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Clock, Effect, Option, Schema } from 'effect'
import { Database, decodeStored, returned } from '../../database/client.ts'
import { MachinePersistenceFailed, type MachineKey } from '../machine.ts'
import { machineBindings } from '../tables.ts'
import { CreateRequest, ProviderId, State } from './protocol.ts'

const Stored = Schema.Struct({
  intent: Schema.String,
  requestedAt: Schema.Int,
  request: CreateRequest,
  providerId: Schema.NullOr(ProviderId),
  observedState: Schema.Union([State, Schema.Literal('intent')]),
  since: Schema.Int,
})
export type Binding = typeof Stored.Type
const decode = decodeStored(Stored, 'Computer machine binding')

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
          .returning(),
      )
      return yield* decode(yield* returned(rows, 'Computer machine binding'))
    },
    (effect) => effect.pipe(Effect.mapError(() => new MachinePersistenceFailed())),
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
  return { load, intend, bind, observe }
})
export type Bindings = Effect.Success<ReturnType<typeof bindings>>
