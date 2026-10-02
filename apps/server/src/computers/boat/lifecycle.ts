import { ComputerState } from '@vivid/contracts'
import { Clock, Effect, Option, Semaphore } from 'effect'
import {
  MachineCreationUnresolved,
  MachineOperationFailed,
  type MachineKey,
  type MachineFailure,
  type RunningMachine,
} from '../machine.ts'
import { active, observations } from './state.ts'
import type { Transport } from './transport.ts'
import type { Bindings } from './bindings.ts'

/** Persist before provisioning, replay only the original intent, and wait for snapshot archival. */
export function lifecycle(api: Transport, saved: Bindings, invalidate: (key: MachineKey) => void) {
  const { bound, running, view, wait } = observations(api, saved)
  const creating = new Set<MachineKey>()
  const permits = new Map<MachineKey, Semaphore.Semaphore>()
  /** The app serializes one Person; this also protects direct Machine users within this process. */
  const permit = (key: MachineKey) => {
    const found = permits.get(key)
    if (found !== undefined) return found
    const value = Semaphore.makeUnsafe(1)
    permits.set(key, value)
    return value
  }
  const ensureUnlocked = Effect.fn('Machine.boat.reconcile')(function* (
    key: MachineKey,
  ): Effect.fn.Return<RunningMachine, MachineFailure> {
    let row = yield* saved.intend(key, api.create)
    if (row.providerId === null) {
      const now = yield* Clock.currentTimeMillis
      if (now - row.requestedAt > 23 * 60 * 60_000)
        return yield* Effect.fail(new MachineCreationUnresolved({ key }))
      const receipt = yield* api.createMachine(row.request, row.intent)
      row = yield* saved.bind(key, row.intent, receipt.sandbox.id)
    }
    const identity = yield* bound(key)
    let record = (yield* api.get(identity.id)).sandbox
    if (record.state === 'archiving') record = yield* wait(key, 'archived')
    if (record.state === 'archived') {
      invalidate(key)
      if (!record.snapshotAvailable)
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'snapshot-missing' }))
      yield* api.transition(identity.id, 'resume')
    }
    return yield* view(key, yield* wait(key, 'running'))
  })
  /** A live create reports Starting immediately; a restart replays only the persisted intent. */
  const ensure = Effect.fn('Machine.boat.ensure')(
    function* (key: MachineKey) {
      creating.add(key)
      return yield* ensureUnlocked(key).pipe(
        Effect.ensuring(Effect.sync(() => creating.delete(key))),
      )
    },
    (effect, key) => permit(key).withPermit(effect),
  )
  const status = Effect.fn('Machine.boat.status')(function* (key: MachineKey) {
    const row = yield* saved.load(key)
    if (Option.isNone(row)) return ComputerState.cases.Absent.make({})
    if (row.value.providerId === null) {
      if (creating.has(key))
        return ComputerState.cases.Starting.make({ since: row.value.requestedAt })
      return yield* ensure(key)
    }
    const record = (yield* api.get(row.value.providerId)).sandbox
    if (active(record.state)) return yield* view(key, record)
    const since = yield* saved.observe(key, row.value, record.state)
    if (record.state === 'archived') {
      if (!record.snapshotAvailable)
        return ComputerState.cases.Failed.make({
          since,
          reason: 'The Computer provider snapshot is unavailable.',
        })
      return ComputerState.cases.Stopped.make({ since })
    }
    if (record.state === 'error' || record.state === 'cancelled')
      return ComputerState.cases.Failed.make({
        since,
        reason: 'The Computer provider could not start the machine.',
      })
    return ComputerState.cases.Starting.make({ since })
  })
  const stop = Effect.fn('Machine.boat.stop')(
    function* (key: MachineKey) {
      const row = yield* saved.load(key)
      if (Option.isNone(row)) return undefined
      // Complete an unbound intent with its original idempotency key before archiving; do not orphan it.
      if (row.value.providerId === null) yield* ensureUnlocked(key)
      const identity = yield* bound(key)
      const record = (yield* api.get(identity.id)).sandbox
      if (record.state === 'archived') return undefined
      invalidate(key)
      yield* api.transition(identity.id, 'stop')
      const archived = yield* wait(key, 'archived')
      if (archived.state !== 'archived' || !archived.snapshotAvailable)
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'snapshot-missing' }))
      yield* saved.observe(key, identity.binding, archived.state)
      return undefined
    },
    (effect, key) => permit(key).withPermit(effect),
  )
  return { ensure, status, stop, running, permit }
}
