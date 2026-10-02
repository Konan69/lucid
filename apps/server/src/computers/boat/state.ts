import { ComputerState } from '@vivid/contracts'
import { Clock, Effect, Option } from 'effect'
import {
  MachineNotRunning,
  MachineOperationFailed,
  MachineResponseInvalid,
  type MachineKey,
} from '../machine.ts'
import type { MachineRecord } from './protocol.ts'
import type { Transport } from './transport.ts'
import type { Bindings } from './bindings.ts'
const screen = ComputerState.cases.Running.fields.screen
export const active = (state: MachineRecord['state']) =>
  state === 'ready' || state === 'idle' || state === 'running'

/** Observe existing provider identity; viewer tokens are ephemeral and never enter persistence. */
export function observations(api: Transport, saved: Bindings) {
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
  const view = Effect.fn('Machine.boat.view')(function* (key: MachineKey, record: MachineRecord) {
    const identity = yield* bound(key)
    const since = yield* saved.observe(key, identity.binding, record.state)
    const issuedAt = yield* Clock.currentTimeMillis
    const viewer = yield* api.viewer(identity.id)
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
    return ComputerState.cases.Running.make({
      since,
      screen: screen.cases.Viewer.make({
        address: viewer.desktopUrl,
        expiresAt: issuedAt + 9 * 60_000,
      }),
    })
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
  return { bound, running, view, wait }
}
