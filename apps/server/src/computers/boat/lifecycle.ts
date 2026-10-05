import { ComputerState } from '@vivid/contracts'
import { Clock, Effect, Match, Option, Semaphore } from 'effect'
import {
  MachineCreationUnresolved,
  MachineHeld,
  MachineState,
  MachineOperationFailed,
  type MachineKey,
  type MachineFailure,
} from '../machine.ts'
import { active, observations } from './state.ts'
import type { Transport } from './transport.ts'
import type { Bindings } from './bindings.ts'
import type { MachineRecord, ProviderId } from './protocol.ts'

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

/** Refuse adoption before writing any intent. Existing unbound paid-create receipts remain
 * untouched: inspect reports Failed (or Starting during ensure), stop fails
 * MachineCreationUnresolved. They may have reached Boat: recovery while held, or after the
 * receipt expires, needs an operator, never a guess. Removing adoption replays the original
 * key within 23 hours. */
const available = Effect.fn('Machine.boat.adoptionAvailable')(function* (
  saved: Bindings,
  key: MachineKey,
  id: ProviderId,
) {
  const held = yield* saved.holder(id)
  if (Option.isSome(held) && held.value.key !== key) return yield* Effect.fail(new MachineHeld())
  return undefined
})

/** The unique constraint guards races after the pre-check. Delete only an intent inserted by
 * this call in this adoption branch: it provably never reached Boat. A pre-existing receipt
 * may represent paid creation and must survive the same race loss unchanged. */
const adopt = Effect.fn('Machine.boat.adopt')(function* (
  saved: Bindings,
  input: {
    readonly key: MachineKey
    readonly intent: Effect.Success<ReturnType<Bindings['intend']>>
    readonly id: ProviderId
  },
) {
  return yield* saved.bind(input.key, input.intent.binding.intent, input.id).pipe(
    Effect.catchTag('MachineHeld', (error) =>
      Effect.gen(function* () {
        if (input.intent.inserted) yield* saved.discard(input.key, input.intent.binding.intent)
        return yield* Effect.fail(error)
      }),
    ),
  )
})

/** Only paid creates have an expiring provider idempotency receipt; adoption creates nothing. */
const bind = Effect.fn('Machine.boat.reconcileBinding')(function* (
  api: Transport,
  saved: Bindings,
  input: {
    readonly key: MachineKey
    readonly intent: Effect.Success<ReturnType<Bindings['intend']>>
  },
) {
  return yield* Option.match(api.adopt, {
    onSome: (id) => adopt(saved, { key: input.key, intent: input.intent, id }),
    onNone: () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (now - input.intent.binding.requestedAt > 23 * 60 * 60_000)
          return yield* Effect.fail(new MachineCreationUnresolved({ key: input.key }))
        const receipt = yield* api.createMachine(
          input.intent.binding.request,
          input.intent.binding.intent,
        )
        return yield* saved.bind(input.key, input.intent.binding.intent, receipt.sandbox.id)
      }),
  })
})

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
    if (Option.isSome(api.adopt)) yield* available(saved, key, api.adopt.value)
    const intent = yield* saved.intend(key, api.create)
    let row = intent.binding
    if (row.providerId === null) row = yield* bind(api, saved, { key, intent })
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
