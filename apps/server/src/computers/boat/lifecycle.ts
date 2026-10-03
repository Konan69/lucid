import { ComputerState } from '@vivid/contracts'
import { Clock, Effect, Match, Option, Semaphore } from 'effect'
import {
  MachineCreationUnresolved,
  MachineState,
  MachineOperationFailed,
  type MachineKey,
  type MachineFailure,
} from '../machine.ts'
import { active, observations } from './state.ts'
import type { Transport } from './transport.ts'
import type { Bindings } from './bindings.ts'
import type { MachineRecord } from './protocol.ts'

/** Provider observations have one exhaustive projection; readiness shares the `active` guard. */
const observedState = (record: MachineRecord, since: number) =>
  Match.value(record).pipe(
    Match.when({ state: active }, () => MachineState.cases.Running.make({ since })),
    Match.when({ state: 'archived' }, ({ snapshotAvailable }) =>
      snapshotAvailable
        ? ComputerState.cases.Stopped.make({ since })
        : ComputerState.cases.Failed.make({
            since,
            reason: 'The Computer provider snapshot is unavailable.',
          }),
    ),
    Match.whenOr({ state: 'error' }, { state: 'cancelled' }, () =>
      ComputerState.cases.Failed.make({
        since,
        reason: 'The Computer provider could not start the machine.',
      }),
    ),
    Match.whenOr(
      { state: 'init' },
      { state: 'provisioning' },
      { state: 'provisioned' },
      { state: 'cloning' },
      { state: 'archiving' },
      () => ComputerState.cases.Starting.make({ since }),
    ),
    Match.exhaustive,
  )

/** Persist before provisioning, replay only the original intent, and wait for snapshot archival. */
export const lifecycle = Effect.fn('Machine.boat.lifecycle')(function* (
  api: Transport,
  saved: Bindings,
  invalidate: (key: MachineKey) => void,
) {
  const { bound, running, permission, wait, invalidateViewer } = yield* observations(api, saved)
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
  ): Effect.fn.Return<typeof MachineState.cases.Running.Type, MachineFailure> {
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
      yield* invalidateViewer(key)
      if (!record.snapshotAvailable)
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'snapshot-missing' }))
      yield* api.transition(identity.id, 'resume')
    }
    const ready = yield* wait(key, 'running')
    return MachineState.cases.Running.make({ since: yield* saved.observe(key, row, ready.state) })
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
  const inspect = Effect.fn('Machine.boat.inspect')(function* (key: MachineKey) {
    const row = yield* saved.load(key)
    if (Option.isNone(row)) return ComputerState.cases.Absent.make({})
    if (row.value.providerId === null) {
      if (creating.has(key))
        return ComputerState.cases.Starting.make({ since: row.value.requestedAt })
      return ComputerState.cases.Failed.make({
        since: row.value.requestedAt,
        reason: 'The Computer creation is unresolved; explicitly start it to reconcile.',
      })
    }
    const record = (yield* api.get(row.value.providerId)).sandbox
    const since = yield* saved.observe(key, row.value, record.state)
    return observedState(record, since)
  })
  /** Viewer issuance is an explicit Person projection of passive lifecycle facts. */
  const status = Effect.fn('Machine.boat.status')(function* (key: MachineKey) {
    const observed = yield* inspect(key)
    if (!MachineState.guards.Running(observed)) return observed
    return ComputerState.cases.Running.make({
      since: observed.since,
      screen: yield* permission(key),
    })
  })
  const stop = Effect.fn('Machine.boat.stop')(
    function* (key: MachineKey) {
      const row = yield* saved.load(key)
      if (Option.isNone(row)) return undefined
      // Stop cannot create a paid machine. Preserve unresolved authority for an explicit Start to reconcile.
      if (row.value.providerId === null)
        return yield* Effect.fail(new MachineCreationUnresolved({ key }))
      const identity = yield* bound(key)
      const record = (yield* api.get(identity.id)).sandbox
      if (record.state === 'archived') return undefined
      invalidate(key)
      yield* invalidateViewer(key)
      yield* api.transition(identity.id, 'stop')
      const archived = yield* wait(key, 'archived')
      if (archived.state !== 'archived' || !archived.snapshotAvailable)
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'snapshot-missing' }))
      yield* saved.observe(key, identity.binding, archived.state)
      return undefined
    },
    (effect, key) => permit(key).withPermit(effect),
  )
  return { ensure, status, inspect, stop, running, permit }
})
