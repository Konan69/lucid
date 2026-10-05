import { ComputerState } from '@vivid/contracts'
import { Clock, Effect, Match, Option, Semaphore } from 'effect'
import {
  MachineCreationUnresolved,
  MachineHeld,
  MachineNoCapacity,
  MachineState,
  MachineOperationFailed,
  type MachineKey,
  type MachineFailure,
} from '../machine.ts'
import { active, observations, type Identity } from './state.ts'
import type { Transport } from './transport.ts'
import type { Binding, Bindings } from './bindings.ts'
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

/**
 * Starts a stopped machine on the first size Boat has free: the configured one, then each larger
 * one (`api.sizes`). Every try is a resume that may not wait (`api.resume`), so each is answered in
 * about two seconds and a refused one leaves the machine stopped. When no size is free the start
 * fails `MachineNoCapacity` with the machine untouched.
 */
const start = Effect.fn('Machine.boat.start')(function* (api: Transport, id: ProviderId) {
  for (const size of api.sizes) {
    const started = yield* api.resume(id, size).pipe(
      Effect.as(true),
      Effect.catchTag('MachineNoCapacity', () => Effect.succeed(false)),
    )
    if (!started) continue
    // The move costs more for as long as the machine runs, so the log says when it happened.
    if (size !== api.sizes[0])
      yield* Effect.logWarning('Computer started on a larger size; its own had no machine free', {
        wanted: api.sizes[0],
        started: size,
      })
    return undefined
  }
  return yield* Effect.fail(new MachineNoCapacity())
})

/**
 * A resume that Boat accepted with no machine to put it on.
 *
 * `provisioning` is Boat looking for a machine and `provisioned` is the machine found: a resume
 * that had one free answered `provisioned` in the same second (5 October 2026). `snapshotAvailable`
 * is what makes it a resume and not a first creation: there is a saved disk to go back to, so the
 * wait can be given up without losing anything. A creation is never taken for one; it has no saved
 * disk yet and is left to finish.
 */
const queued = (record: MachineRecord): boolean =>
  record.state === 'provisioning' && record.snapshotAvailable

/** How long a resume may be seen without a machine before it counts as left waiting. A machine
 * that is free is given within a second, so this only spares a resume asked for a moment ago. */
const QUEUE_GRACE_MILLIS = 10_000

/**
 * Gives up a resume that Boat left waiting for a machine, so that `start` can ask for one that is
 * free. This is the state another caller leaves behind when it resumes without `failFast` (an SSH
 * wake did on 5 October 2026: two hours in `provisioning`, no error, and every start from here
 * only waited with it). The stop was tried on that machine: Boat answered 202 and the machine was
 * `archived` five seconds later with its saved disk as it was, because a machine that was never
 * placed has nothing new to save. `force` stays false, so a stop Boat cannot make safely is
 * refused by Boat.
 *
 * How long it has waited is read from the binding: `observe` keeps the time Vivid first saw the
 * state, and every status read of a Person's Computer records it. A resume first seen less than
 * the grace ago is returned as it is, and the caller waits for it as it always did.
 */
const withdrawn = Effect.fn('Machine.boat.withdrawn')(function* (
  api: Transport,
  saved: Bindings,
  wait: Effect.Success<ReturnType<typeof observations>>['wait'],
  input: { readonly key: MachineKey; readonly row: Binding; readonly record: MachineRecord },
) {
  const since = yield* saved.observe(input.key, input.row, input.record.state)
  if ((yield* Clock.currentTimeMillis) - since < QUEUE_GRACE_MILLIS) return input.record
  yield* Effect.logWarning('Computer start was left waiting for a machine; withdrawing it')
  yield* api.stop(input.record.id)
  return yield* wait(input.key, 'archived')
})

/**
 * Persist before provisioning, replay only the original intent, and wait for snapshot archival.
 *
 * `admit` is the adapter's question to a running machine, whether this binding is its holder
 * (`holder.ts`). The two things here that act on a running machine without waking it ask first:
 * the screen and the stop.
 */
export const lifecycle = Effect.fn('Machine.boat.lifecycle')(function* (
  api: Transport,
  saved: Bindings,
  invalidate: (key: MachineKey) => void,
  admit: (key: MachineKey, identity: Identity) => Effect.Effect<Identity, MachineFailure>,
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
    if (queued(record)) record = yield* withdrawn(api, saved, wait, { key, row, record })
    if (record.state === 'archived') {
      invalidate(key)
      yield* invalidateViewer(key)
      if (!record.snapshotAvailable)
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'snapshot-missing' }))
      yield* start(api, identity.id)
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
    // The screen is the holder's alone: the machine is asked before a viewer is issued for it.
    yield* admit(key, yield* bound(key))
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
      // A running machine is stopped only by its holder. One between states takes no command, so
      // it cannot be asked; the stop is sent as it always was.
      if (active(record.state)) yield* admit(key, identity)
      invalidate(key)
      yield* invalidateViewer(key)
      yield* api.stop(identity.id)
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
