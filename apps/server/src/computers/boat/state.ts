import { ComputerState } from '@vivid/contracts'
import { Cache, Clock, Effect, Exit, Option } from 'effect'
import {
  MachineNotRunning,
  MachineOperationFailed,
  MachineResponseInvalid,
  type MachineKey,
} from '../machine.ts'
import type { MachineRecord, ProviderId } from './protocol.ts'
import type { Transport } from './transport.ts'
import type { Bindings } from './bindings.ts'
const screen = ComputerState.cases.Running.fields.screen
export const active = (state: MachineRecord['state']) =>
  state === 'ready' || state === 'idle' || state === 'running'

/** Observe existing provider identity; viewer tokens are ephemeral and never enter persistence. */
export const observations = Effect.fn('Machine.boat.observations')(function* (
  api: Transport,
  saved: Bindings,
) {
  const bound = Effect.fn('Machine.boat.bound')(function* (key: MachineKey) {
    const row = yield* saved.load(key)
    if (Option.isNone(row) || row.value.providerId === null)
      return yield* Effect.fail(new MachineNotRunning({ key }))
    return { binding: row.value, id: row.value.providerId }
  })
  const running = Effect.fn('Machine.boat.running')(function* (key: MachineKey) {
    const identity = yield* bound(key)
    const record = (yield* api.get(identity.id)).sandbox
    if (!active(record.state)) return yield* Effect.fail(new MachineNotRunning({ key }))
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
        return yield* Effect.fail(new MachineResponseInvalid({ operation: 'viewer' }))
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
  /** Poll only observation; never replay input. Timeout preserves the binding for the next request. */
  const wait = Effect.fn('Machine.boat.wait')(function* (
    key: MachineKey,
    wanted: 'running' | 'archived',
  ) {
    const identity = yield* bound(key)
    for (let attempt = 0; attempt < 300; attempt++) {
      const record = (yield* api.get(identity.id)).sandbox
      if (wanted === 'archived' ? record.state === 'archived' : active(record.state)) return record
      if (record.state === 'error' || record.state === 'cancelled')
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'lifecycle' }))
      yield* Effect.sleep('2 seconds')
    }
    return yield* Effect.fail(new MachineOperationFailed({ operation: 'lifecycle-timeout' }))
  })
  return { bound, running, permission, wait, invalidateViewer }
})
