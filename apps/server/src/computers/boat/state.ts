import { ComputerState } from '@vivid/contracts'
import { Cache, Clock, Duration, Effect, Exit, Option, Schedule, Schema } from 'effect'
import {
  MachineNotRunning,
  MachineOperationFailed,
  MachineLifecycleStalled,
  MachineResponseInvalid,
  type MachineKey,
} from '../machine.ts'
import type { ProviderId } from './protocol.ts'
import { State } from './protocol.ts'
import type { Transport } from './transport.ts'
import type { Bindings } from './bindings.ts'
/** Boat's unary lifecycle endpoint exposes no subscription. Read only its observations, never
 * replay a mutation. Source: unmeasured. Two seconds paces requests while the owner may cancel. */
const OBSERVATION_CADENCE = Duration.seconds(2)
/** Provider state transitions renew this idle bound. Source: unmeasured. Ten minutes without
 * a new state fails the lifecycle observation and retains its durable binding for reconciliation. */
const LIFECYCLE_IDLE = Duration.minutes(10)

const screen = ComputerState.cases.Running.fields.screen
/** The usable subset is declared once, constrained by the decoded provider vocabulary. */
export const active = Schema.is(State.pick(['ready', 'idle', 'running']))

/** Observe existing provider identity; viewer tokens are ephemeral and never enter persistence. */
export const observations = Effect.fn('Machine.boat.observations')(function* (
  api: Transport,
  saved: Bindings,
) {
  const bound = Effect.fn('Machine.boat.bound')(function* (key: MachineKey) {
    const row = yield* saved.load(key)
    if (Option.isNone(row) || row.value.providerId === null)
      return yield* new MachineNotRunning({ key })
    return { binding: row.value, id: row.value.providerId }
  })
  const running = Effect.fn('Machine.boat.running')(function* (key: MachineKey) {
    const identity = yield* bound(key)
    const record = (yield* api.get(identity.id)).sandbox
    if (!active(record.state)) return yield* new MachineNotRunning({ key })
    return identity
  })
  /** Boat documents a ten-minute permission lifetime. Cache authority only in this Layer, renew a minute early,
   * and let Cache share concurrent misses. Failed issuance has zero TTL and never replaces a valid fact. */
  const viewers = yield* Cache.makeWith(
    Effect.fn('Machine.boat.viewer')(function* (id: ProviderId) {
      const issuedAt = yield* Clock.currentTimeMillis
      const viewer = yield* api.viewer(id)
      // Boat's default Moonlight viewer uses a fragment token and expires in ten minutes.
      const valid = yield* Effect.try({
        try: () => new URL(viewer.desktopUrl),
        catch: () => new MachineResponseInvalid({ operation: 'viewer' }),
      })
      if (
        valid.protocol !== 'https:' ||
        valid.pathname !== '/stream.html' ||
        !valid.hash.startsWith('#token=') ||
        valid.hash.length <= 7
      )
        return yield* new MachineResponseInvalid({ operation: 'viewer' })
      const cachedAt = yield* Clock.currentTimeMillis
      return {
        issuedAt,
        // Cache rc.116 starts TTL when lookup completes; provider latency must not extend authority.
        ttlMillis: Math.max(0, issuedAt + 9 * 60_000 - cachedAt),
        permission: screen.cases.Viewer.make({
          address: viewer.desktopUrl,
          expiresAt: issuedAt + 10 * 60_000,
        }),
      }
    }),
    {
      capacity: Number.POSITIVE_INFINITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.ttlMillis : 0),
    },
  )
  /** This projection is the only issuer; execution observations never call it. */
  const permission = Effect.fn('Machine.boat.permission')(function* (key: MachineKey) {
    const identity = yield* bound(key)
    return (yield* Cache.get(viewers, identity.id)).permission
  })
  /** Suspend/resume invalidates ephemeral authority without persisting or logging it. */
  const invalidateViewer = Effect.fn('Machine.boat.invalidateViewer')(function* (key: MachineKey) {
    const identity = yield* bound(key)
    yield* Cache.invalidate(viewers, identity.id)
  })
  /** Provisioning and archival may grow with the disk. Observe progress with an idle bound,
   * not an attempt count that expires even when the provider continues moving forward. */
  const wait = Effect.fn('Machine.boat.wait')(function* (
    key: MachineKey,
    wanted: 'running' | 'archived',
  ) {
    const identity = yield* bound(key)
    let previous = Option.none<typeof State.Type>()
    let progressedAt = yield* Clock.currentTimeMillis
    const reached = (state: typeof State.Type) =>
      wanted === 'archived' ? state === 'archived' : active(state)
    const observe = Effect.fn('Machine.boat.observeLifecycle')(function* () {
      const record = (yield* api.get(identity.id)).sandbox
      if (reached(record.state)) return record
      if (record.state === 'error' || record.state === 'cancelled')
        return yield* new MachineOperationFailed({ operation: 'lifecycle' })
      const now = yield* Clock.currentTimeMillis
      if (Option.isNone(previous) || previous.value !== record.state) {
        previous = Option.some(record.state)
        progressedAt = now
      } else if (now - progressedAt >= Duration.toMillis(LIFECYCLE_IDLE))
        return yield* new MachineLifecycleStalled({ key })
      return record
    })
    return yield* observe().pipe(
      Effect.repeat({
        until: (record) => reached(record.state),
        schedule: Schedule.spaced(OBSERVATION_CADENCE),
      }),
    )
  })
  return { bound, running, permission, wait, invalidateViewer }
})

/** A bound machine: its binding row and the provider's id for it. */
export type Identity = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof observations>>['bound']>
>
