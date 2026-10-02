import * as NodeCrypto from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import {
  Clock,
  Context,
  Effect,
  Fiber,
  Layer,
  Match,
  Option,
  Result,
  Schema,
  Semaphore,
  Scope,
} from 'effect'
import {
  ActionTarget,
  BrowserAction,
  DesktopAction,
  DesktopOutcome,
  type DesktopView,
  type UseDesktopRequest,
  BrowseOutcome,
  CommandOutcome,
  ProposedAction,
  type BrowseRequest,
  type RunCommandRequest,
  type Person,
  Computer,
  ComputerId,
  ComputerState,
  PersonId,
  type CommandResult,
  type BrowseResult,
} from '@vivid/contracts'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import { type Actor } from '../auth/access.ts'
import { Gate, GateDecision, ActionOutcome } from '../approvals/gate.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Machine, MachineKey, type MachineFailure, type MachineScreen } from './machine.ts'
import { computers } from './tables.ts'

export { computerScreenAddress } from './machine.ts'

const columns = {
  id: ComputerId,
  personId: PersonId,
  machine: MachineKey,
  since: Schema.Number,
  lastActivityAt: Schema.Number,
  held: Schema.Boolean,
}
const Stored = Schema.Union([
  Schema.Struct({ ...columns, status: Schema.Literal('starting'), reason: Schema.Null }),
  Schema.Struct({ ...columns, status: Schema.Literal('running'), reason: Schema.Null }),
  Schema.Struct({ ...columns, status: Schema.Literal('stopped'), reason: Schema.Null }),
  Schema.Struct({ ...columns, status: Schema.Literal('failed'), reason: Schema.String }),
]).pipe(Schema.toTaggedUnion('status'))
type Stored = typeof Stored.Type
type StateColumns = Pick<typeof computers.$inferInsert, 'status' | 'since' | 'reason'>
const decode = decodeStored(Stored, 'Computer')

/** Only the typed provider failure is translated, without leaking commands, credentials or host details. */
export const machineFailureReason = (failure: MachineFailure): string =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      MachineUnavailable: () => 'No Computer provider is configured on this installation.',
      MachineConfigurationInvalid: () =>
        'The Computer provider configuration is incomplete or invalid.',
      MachineAuthenticationFailed: () => 'The Computer provider credentials were refused.',
      MachineCreationUnresolved: () =>
        'The Computer creation receipt needs reconciliation; another machine will not be created.',
      MachineRequestRejected: () => 'The Computer provider refused the operation.',
      MachinePersistenceFailed: () => 'The Computer provider binding could not be saved or read.',
      MachineCapabilityUnavailable: ({ capability }) =>
        `The configured Computer provider does not support ${capability}.`,
      MachineNotRunning: () => 'The Computer is no longer running.',
      MachineOperationFailed: () => 'The Computer provider could not finish the operation.',
      MachineResponseInvalid: () => 'The Computer provider returned an invalid response.',
      MachineInputInvalid: () => 'The command or its time limit is invalid.',
      BrowserAddressRefused: () =>
        'The browser address is refused; use a public HTTP or HTTPS address.',
      BrowserStepFailed: () => 'The browser could not complete the requested step.',
      MachineExecutionUnknown: () =>
        'The command receipt was lost; it may have run. Do not retry it automatically.',
    }),
  )

/** A digest keeps provider storage names independent of Person ids and legal for every local provider. */
export const computerMachineKey = (person: PersonId): MachineKey =>
  MachineKey.make(NodeCrypto.createHash('sha256').update(person).digest('hex').slice(0, 48))

/** Screen authority comes from the provider on this read; URLs are never reconstructed from persisted status. */
const wire = (row: Stored, state: ComputerState): Computer =>
  Computer.make({ id: row.id, heldByPerson: row.held, state })

/** Absence and disabled installation are distinct even before a record exists. */
const withoutRow = (state: ComputerState): Computer =>
  Computer.make({ id: null, state, heldByPerson: false })

export const ComputerAccess = Schema.TaggedUnion({
  Ready: { key: MachineKey },
  Unavailable: { reason: Schema.String },
})
export type ComputerAccess = typeof ComputerAccess.Type

/** Passive access reports status; only the permitted execution path may wake the Computer. */
const accessTo = (computer: Computer, key: MachineKey): ComputerAccess => {
  if (computer.heldByPerson)
    return ComputerAccess.cases.Unavailable.make({ reason: 'the Person is using the Computer' })
  return ComputerState.match(computer.state, {
    Running: (): ComputerAccess => ComputerAccess.cases.Ready.make({ key }),
    Absent: () =>
      ComputerAccess.cases.Unavailable.make({
        reason: 'The Person has not started a Computer yet; it is absent.',
      }),
    Starting: () =>
      ComputerAccess.cases.Unavailable.make({
        reason: 'The Computer is starting. Wait for it to finish starting.',
      }),
    Stopped: () =>
      ComputerAccess.cases.Unavailable.make({
        reason: 'The Computer is stopped. Ask the Person to start it.',
      }),
    Failed: ({ reason }) =>
      ComputerAccess.cases.Unavailable.make({ reason: `The Computer failed to start. ${reason}` }),
    Unavailable: () =>
      ComputerAccess.cases.Unavailable.make({
        reason: 'No Computer provider is configured on this installation.',
      }),
  })
}

/** Comparing the persisted state prevents read/publish loops when the provider has not changed. */
const sameState = (row: Stored, state: ComputerState): boolean =>
  ComputerState.match(state, {
    Absent: () => false,
    Unavailable: () => false,
    Starting: ({ since }) => Stored.guards.starting(row) && row.since === since,
    Running: ({ since }) => Stored.guards.running(row) && row.since === since,
    Stopped: ({ since }) => Stored.guards.stopped(row) && row.since === since,
    Failed: ({ since, reason }) =>
      Stored.guards.failed(row) && row.since === since && row.reason === reason,
  })

/** All record reads and mutations are constrained by Person ownership, including background completions. */
const persistence = Effect.fn('ComputerStore.persistence')(function* () {
  const database = yield* Database
  const changes = yield* Changes
  const load = Effect.fn('ComputerStore.load')(function* (person: PersonId) {
    const rows = yield* database.run(
      database.select().from(computers).where(eq(computers.personId, person)).limit(1),
    )
    const row = rows[0]
    return row === undefined ? Option.none<Stored>() : Option.some(yield* decode(row))
  })
  const publish = Effect.fn('ComputerStore.publish')((person: PersonId) =>
    changes.publish([Topic.person(person)]),
  )
  /** Compare the generation and state so a stale read or worker cannot overwrite a newer lifecycle transition. */
  const update = Effect.fn('ComputerStore.update')(function* (
    person: PersonId,
    before: Stored,
    state: ComputerState,
  ) {
    const values = ComputerState.match(state, {
      Absent: (): StateColumns => ({
        status: 'stopped',
        since: before.since,
        reason: null,
      }),
      Starting: ({ since }) => ({ status: 'starting', since, reason: null }),
      Running: ({ since }) => ({ status: 'running', since, reason: null }),
      Stopped: ({ since }) => ({ status: 'stopped', since, reason: null }),
      Failed: ({ since, reason }) => ({ status: 'failed', since, reason }),
      Unavailable: () => ({
        status: 'failed',
        since: before.since,
        reason: 'No Computer provider is configured on this installation.',
      }),
    })
    const rows = yield* database.run(
      database
        .update(computers)
        .set(values)
        .where(
          and(
            eq(computers.personId, person),
            eq(computers.status, before.status),
            eq(computers.since, before.since),
          ),
        )
        .returning(),
    )
    if (rows.length > 0) yield* publish(person)
    return yield* load(person)
  })
  /** Claim startup atomically; only the RETURNING owner may fork an ensure. */
  const starting = Effect.fn('ComputerStore.starting')(function* (person: PersonId) {
    const since = yield* Clock.currentTimeMillis
    const claimed = yield* database.run(
      database
        .insert(computers)
        .values({
          id: NodeCrypto.randomUUID(),
          personId: person,
          machine: computerMachineKey(person),
          status: 'starting',
          since,
          held: false,
          reason: null,
          createdAt: since,
          lastActivityAt: since,
        })
        .onConflictDoUpdate({
          target: computers.personId,
          set: { status: 'starting', since, lastActivityAt: since, reason: null },
          setWhere: inArray(computers.status, ['stopped', 'failed']),
        })
        .returning(),
    )
    const row = claimed[0]
    if (row === undefined) return Option.none<Stored>()
    yield* publish(person)
    return Option.some(yield* decode(row))
  })
  /** Holding an absent Computer does not create one. Keyboard ownership is independent of workspace. */
  const hold = Effect.fn('ComputerStore.holdRow')(function* (person: PersonId, held: boolean) {
    const rows = yield* database.run(
      database.update(computers).set({ held }).where(eq(computers.personId, person)).returning(),
    )
    if (rows.length > 0) yield* publish(person)
  })
  /** Startup restores timers from persisted activity; it never treats a restart as new activity. */
  const active = Effect.fn('ComputerStore.active')(function* () {
    const values = yield* database.run(
      database
        .select()
        .from(computers)
        .where(inArray(computers.status, ['starting', 'running'])),
    )
    return yield* Effect.forEach(values, decode)
  })
  /** Milliseconds are durable so inactivity survives server restarts. */
  const touch = Effect.fn('ComputerStore.touch')(function* (person: PersonId) {
    const lastActivityAt = yield* Clock.currentTimeMillis
    yield* database.run(
      database.update(computers).set({ lastActivityAt }).where(eq(computers.personId, person)),
    )
  })
  return { load, update, starting, hold, active, touch }
})

type Persistence = Effect.Success<ReturnType<typeof persistence>>

/** The scope owns the worker; failure is persisted, and stale generations cannot be resurrected. */
const startMachine = Effect.fn('ComputerStore.boot')(function* (
  machine: typeof Machine.Service,
  rows: Persistence,
  person: PersonId,
  before: Stored,
) {
  const current = yield* rows.load(person)
  if (
    Option.isNone(current) ||
    !Stored.guards.starting(current.value) ||
    current.value.since !== before.since
  )
    return
  const state = yield* machine.ensure(before.machine).pipe(
    Effect.timeout('90 seconds'),
    Effect.catchTag('TimeoutError', () => Effect.fail(new ComputerWakeTimedOut({ person }))),
    Effect.match({
      onFailure: (failure) =>
        ComputerState.cases.Failed.make({
          since: before.since,
          reason:
            failure instanceof ComputerWakeTimedOut
              ? 'The Computer did not become ready within 90 seconds.'
              : machineFailureReason(failure),
        }),
      onSuccess: (running) => running,
    }),
  )
  yield* rows.update(person, before, state)
})
type StoreError = DatabaseInfrastructureError
export interface ComputerStoreService {
  readonly get: (person: PersonId) => Effect.Effect<Computer, StoreError>
  readonly start: (person: PersonId) => Effect.Effect<Computer, StoreError>
  readonly stop: (person: PersonId) => Effect.Effect<Computer, StoreError>
  readonly hold: (person: PersonId, held: boolean) => Effect.Effect<Computer, StoreError>
  readonly access: (person: PersonId) => Effect.Effect<ComputerAccess, StoreError>
  readonly watching: (person: PersonId) => Effect.Effect<void, StoreError, Scope.Scope>
  readonly screen: (person: PersonId) => Effect.Effect<Option.Option<MachineScreen>, StoreError>
  readonly exec: (
    person: PersonId,
    input: { readonly command: string; readonly timeoutSeconds: number },
  ) => Effect.Effect<CommandResult, StoreError | MachineFailure | ReadinessFailure>
  readonly desktop: (
    person: PersonId,
    action: DesktopAction,
  ) => Effect.Effect<DesktopView, StoreError | MachineFailure | ReadinessFailure>
  readonly browse: (
    person: PersonId,
    action: BrowserAction,
  ) => Effect.Effect<BrowseResult, StoreError | MachineFailure | ReadinessFailure>
}

/** A bounded wake wait is distinct from takeover, provider absence and failed startup. */
export class ComputerWakeTimedOut extends Schema.TaggedError<ComputerWakeTimedOut>()(
  'ComputerWakeTimedOut',
  { person: PersonId },
  { title: 'Computer readiness timed out' },
) {}

/** Takeover is a human ownership decision, never a reason to retry startup. */
export class ComputerHeld extends Schema.TaggedError<ComputerHeld>()(
  'ComputerHeld',
  { person: PersonId },
  { title: 'The Person is using the Computer' },
) {}
/** Provider absence is an installation dependency, not failed creation. */
export class ComputerProviderUnavailable extends Schema.TaggedError<ComputerProviderUnavailable>()(
  'ComputerProviderUnavailable',
  { person: PersonId },
  { title: 'Computer provider unavailable' },
) {}
/** A failed startup needs an explicit restart, preserving its recorded failure reason. */
export class ComputerStartFailed extends Schema.TaggedError<ComputerStartFailed>()(
  'ComputerStartFailed',
  { person: PersonId, reason: Schema.String },
  { title: 'Computer startup failed' },
) {}
type ReadinessFailure =
  | ComputerHeld
  | ComputerProviderUnavailable
  | ComputerStartFailed
  | ComputerNotReady
  | ComputerWakeTimedOut

/** Execution refusal is not a provider error and keeps the Person's precise lifecycle reason. */
export class ComputerNotReady extends Schema.TaggedError<ComputerNotReady>()(
  'ComputerNotReady',
  { reason: Schema.String },
  { title: 'ComputerNotReady' },
) {}
/** Authority over one Person's persisted Computer, independent of Company or transport. */
export class ComputerStore extends Context.Service<ComputerStore, ComputerStoreService>()(
  'vivid/ComputerStore',
) {}

/** A permit belongs to a Person, so independent Computers never share an application lifecycle lock. */
const personLocks = () => {
  const locks = new Map<PersonId, Semaphore.Semaphore>()
  /** Every operation for one Person shares one permit; different Persons remain independent. */
  return (person: PersonId) => {
    const found = locks.get(person)
    if (found !== undefined) return found
    const created = Semaphore.makeUnsafe(1)
    locks.set(person, created)
    return created
  }
}

/** Scoped lifecycle workers and Person locks order start/stop/hold/execution without tying startup to an RPC fiber. */
const lifecycle = Effect.fn('ComputerStore.lifecycle')(function* () {
  const rows = yield* persistence()
  const machine = yield* Machine
  const scope = yield* Effect.scope
  const pending = new Set<PersonId>()
  const workers = new Map<PersonId, Fiber.Fiber<void>>()
  /** Startup markers precede publication; cleanup removes both ownership records together. */
  const forget = Effect.fn('ComputerStore.forget')((person: PersonId) =>
    Effect.sync(() => {
      pending.delete(person)
      workers.delete(person)
    }),
  )
  const lock = personLocks()
  /** Provider absence maps to stopped only for an existing row, never an invented running address. */
  const get = Effect.fn('ComputerStore.get')(function* (person: PersonId) {
    const row = yield* rows.load(person)
    const key = Option.match(row, {
      onNone: () => computerMachineKey(person),
      onSome: (value) => value.machine,
    })
    const recordedSince = Option.isSome(row) ? row.value.since : yield* Clock.currentTimeMillis
    const reported = yield* machine.status(key).pipe(
      Effect.catch((failure) =>
        Effect.succeed(
          ComputerState.cases.Failed.make({
            since: recordedSince,
            reason: machineFailureReason(failure),
          }),
        ),
      ),
    )
    if (ComputerState.guards.Unavailable(reported)) return withoutRow(reported)
    if (Option.isNone(row)) return withoutRow(ComputerState.cases.Absent.make({}))
    if (pending.has(person) && Stored.guards.starting(row.value))
      return wire(row.value, ComputerState.cases.Starting.make({ since: row.value.since }))
    if (Stored.guards.failed(row.value) && !ComputerState.guards.Running(reported))
      return wire(
        row.value,
        ComputerState.cases.Failed.make({ since: row.value.since, reason: row.value.reason }),
      )
    const actual = ComputerState.guards.Absent(reported)
      ? ComputerState.cases.Stopped.make({ since: row.value.since })
      : reported
    const current = wire(row.value, actual)
    if (sameState(row.value, actual)) return current
    const updated = yield* rows.update(person, row.value, actual)
    return Option.match(updated, {
      onNone: () => withoutRow(ComputerState.cases.Absent.make({})),
      onSome: (value) => wire(value, actual),
    })
  })
  /** Start returns the persisted starting receipt before its scope-owned worker acquires the lifecycle permit. */
  const begin = Effect.fn('ComputerStore.begin')(
    function* (person: PersonId) {
      const current = yield* get(person)
      if (ComputerState.isAnyOf(['Running', 'Unavailable'])(current.state)) return current
      pending.add(person)
      const claim = ComputerState.guards.Starting(current.state)
        ? rows.load(person)
        : rows.starting(person)
      const row = yield* claim.pipe(
        Effect.onError(() => forget(person)),
        Effect.onInterrupt(() => forget(person)),
      )
      if (Option.isNone(row)) {
        yield* forget(person)
        return yield* get(person)
      }
      const worker = yield* startMachine(machine, rows, person, row.value).pipe(
        (effect) => lock(person).withPermit(effect),
        Effect.catch(() => Effect.logError('Computer startup state could not be persisted.')),
        Effect.ensuring(forget(person)),
        Effect.forkIn(scope, { startImmediately: false }),
      )
      workers.set(person, worker)
      return wire(row.value, ComputerState.cases.Starting.make({ since: row.value.since }))
    },
    (effect, person) => lock(person).withPermit(effect),
  )
  /** An idempotent request during startup returns its receipt immediately, without waiting for ensure. */
  const start = Effect.fn('ComputerStore.start')(function* (person: PersonId) {
    if (pending.has(person)) return yield* get(person)
    return yield* begin(person)
  })
  /** Stop is ordered after startup and records a provider failure rather than claiming the machine stopped. */
  const halt = Effect.fn('ComputerStore.halt')(
    function* (person: PersonId) {
      const current = yield* get(person)
      if (ComputerState.guards.Unavailable(current.state)) return current
      const row = yield* rows.load(person)
      if (Option.isNone(row)) return current
      const stopped = yield* machine.stop(row.value.machine).pipe(Effect.result)
      const now = yield* Clock.currentTimeMillis
      const state = Result.match(stopped, {
        onFailure: (failure) =>
          ComputerState.cases.Failed.make({ since: now, reason: machineFailureReason(failure) }),
        onSuccess: (): ComputerState => ComputerState.cases.Stopped.make({ since: now }),
      })
      yield* rows.update(person, row.value, state)
      return Option.match(yield* rows.load(person), {
        onNone: () => withoutRow(ComputerState.cases.Absent.make({})),
        onSome: (value) => wire(value, state),
      })
    },
    (effect, person) => lock(person).withPermit(effect),
  )
  /** Cancel a starting worker before taking its permit; provider cleanup finishes before stop records its receipt. */
  const stop = Effect.fn('ComputerStore.stop')(function* (person: PersonId) {
    const worker = workers.get(person)
    if (worker !== undefined) yield* Fiber.interrupt(worker)
    yield* forget(person)
    return yield* halt(person)
  })
  /** Taking or releasing the keyboard shares the execution permit, so no new action begins while held. */
  const hold = Effect.fn('ComputerStore.hold')(
    function* (person: PersonId, held: boolean) {
      yield* rows.hold(person, held)
      return yield* get(person)
    },
    (effect, person) => lock(person).withPermit(effect),
  )
  return { get, start, stop, hold, lock, rows, machine, workers }
})

/** Actions may wake absent/stopped machines once; failed starts require an explicit Person decision.
 * Starting uses the same provider ensure receipt, including a persisted startup after a restart. */
const prepare = Effect.fn('ComputerStore.prepare')(
  function* (state: Effect.Success<ReturnType<typeof lifecycle>>, person: PersonId) {
    const current = yield* state.get(person)
    if (current.heldByPerson) return
    if (ComputerState.isAnyOf(['Absent', 'Stopped', 'Starting'])(current.state))
      yield* state.start(person)
    const worker = state.workers.get(person)
    if (worker !== undefined) yield* Fiber.await(worker)
  },
  (effect, _state, person) =>
    effect.pipe(
      Effect.timeout('90 seconds'),
      Effect.catchTag('TimeoutError', () => Effect.fail(new ComputerWakeTimedOut({ person }))),
    ),
)

/** Resolve a running provider handle after the permit is acquired; each terminal refusal has its own tag. */
const requireReady = Effect.fn('ComputerStore.requireReady')(function* (
  state: Effect.Success<ReturnType<typeof lifecycle>>,
  person: PersonId,
) {
  const computer = yield* state.get(person)
  if (computer.heldByPerson) return yield* Effect.fail(new ComputerHeld({ person }))
  if (ComputerState.guards.Unavailable(computer.state))
    return yield* Effect.fail(new ComputerProviderUnavailable({ person }))
  if (ComputerState.guards.Failed(computer.state))
    return yield* Effect.fail(new ComputerStartFailed({ person, reason: computer.state.reason }))
  const ready = accessTo(computer, computerMachineKey(person))
  if (ComputerAccess.guards.Unavailable(ready))
    return yield* Effect.fail(new ComputerNotReady({ reason: ready.reason }))
  const row = yield* state.rows.load(person)
  if (Option.isNone(row))
    return yield* Effect.fail(new ComputerNotReady({ reason: 'The Computer is absent.' }))
  return row.value.machine
})

/** One scoped timer owns each Computer's idle deadline. Activity cancels it before updating time.
 * Watches are counted by subscription lifetime, never by repeated status reads. Keyboard ownership also suppresses stop. */
const idle = Effect.fn('ComputerStore.idle')(function* (
  state: Effect.Success<ReturnType<typeof lifecycle>>,
) {
  const scope = yield* Effect.scope
  const timers = new Map<PersonId, Fiber.Fiber<void>>()
  const watchers = new Map<PersonId, number>()
  const cancel = Effect.fn('ComputerStore.cancelIdle')(function* (person: PersonId) {
    const timer = timers.get(person)
    timers.delete(person)
    if (timer !== undefined) yield* Fiber.interrupt(timer)
  })
  /** Recheck stored activity under the action permit before stopping, so an old deadline cannot win a race. */
  const expire = Effect.fn('ComputerStore.expire')(function* (before: Stored) {
    timers.delete(before.personId)
    yield* state.lock(before.personId).withPermit(
      Effect.gen(function* () {
        const current = yield* state.rows.load(before.personId)
        if (Option.isNone(current) || current.value.held || watchers.has(before.personId)) return
        if (!Stored.isAnyOf(['starting', 'running'])(current.value)) return
        if (current.value.lastActivityAt !== before.lastActivityAt) return
        const result = yield* state.machine.stop(current.value.machine).pipe(Effect.result)
        const since = yield* Clock.currentTimeMillis
        const next = Result.match(result, {
          onSuccess: () => ComputerState.cases.Stopped.make({ since }),
          onFailure: (failure) =>
            ComputerState.cases.Failed.make({ since, reason: machineFailureReason(failure) }),
        })
        yield* state.rows.update(before.personId, current.value, next)
      }),
    )
  })
  /** Timers use the stored epoch deadline, including immediately overdue Computers after a restart. */
  const arm = Effect.fn('ComputerStore.armIdle')(function* (person: PersonId) {
    yield* cancel(person)
    const row = yield* state.rows.load(person)
    if (Option.isNone(row) || row.value.held || watchers.has(person)) return
    if (!Stored.isAnyOf(['starting', 'running'])(row.value)) return
    const now = yield* Clock.currentTimeMillis
    const delay = Math.max(0, row.value.lastActivityAt + 20 * 60_000 - now)
    const timer = yield* Effect.sleep(delay).pipe(
      Effect.andThen(expire(row.value)),
      Effect.catch(() => Effect.logError('Computer idle stop could not be persisted.')),
      Effect.forkIn(scope, { startImmediately: false }),
    )
    timers.set(person, timer)
  })
  /** Completion resets inactivity too, so a long command is not stopped while executing. */
  const activity = Effect.fn('ComputerStore.activity')(function* (person: PersonId) {
    yield* cancel(person)
    yield* state.rows.touch(person)
  })
  /** The subscription count is independent of workspace; acquire rolls back if timestamp persistence fails. */
  const watchOpen = Effect.fn('ComputerStore.watchOpen')(
    function* (person: PersonId) {
      yield* activity(person)
      watchers.set(person, (watchers.get(person) ?? 0) + 1)
    },
    (effect, person) => state.lock(person).withPermit(effect),
  )
  /** The last departing watcher starts a full idle period from its durable departure time. */
  const watchClose = Effect.fn('ComputerStore.watchClose')(
    function* (person: PersonId) {
      const count = watchers.get(person)
      if (count !== undefined && count > 1) watchers.set(person, count - 1)
      else watchers.delete(person)
      yield* activity(person)
      yield* arm(person)
    },
    (effect, person) => state.lock(person).withPermit(effect),
    Effect.catch(() => Effect.logError('Computer watch release could not be persisted.')),
  )
  /** The stream scope owns presence, including cancellation and disconnected clients. */
  const watching = Effect.fn('ComputerStore.watching')((person: PersonId) =>
    Effect.acquireRelease(watchOpen(person), () => watchClose(person)).pipe(Effect.asVoid),
  )
  const active = yield* state.rows.active()
  yield* Effect.forEach(active, (row) => arm(row.personId))
  return { activity, arm, watching, cancel }
})

/** Capture provider and database dependencies once; callers need only the Computer authority. */
export const computerStoreLayer = Layer.effect(
  ComputerStore,
  Effect.gen(function* () {
    const state = yield* lifecycle()
    const inactivity = yield* idle(state)
    /** Resolve provider identity only after a current lifecycle and keyboard-ownership check. */
    const access = Effect.fn('ComputerStore.access')(function* (person: PersonId) {
      const row = yield* state.rows.load(person)
      const computer = yield* state.get(person)
      const result = accessTo(computer, computerMachineKey(person))
      if (ComputerAccess.guards.Unavailable(result)) return result
      if (Option.isNone(row))
        return ComputerAccess.cases.Unavailable.make({ reason: 'The Computer is absent.' })
      return ComputerAccess.cases.Ready.make({ key: row.value.machine })
    })
    /** The session's Person owns the endpoint; a fresh screen check returns 404 for a lost machine without warming action status checks. */
    const screen = Effect.fn('ComputerStore.screen')(function* (person: PersonId) {
      const row = yield* state.rows.load(person)
      if (Option.isNone(row) || !Stored.guards.running(row.value))
        return Option.none<MachineScreen>()
      const actual = yield* state.machine.status(row.value.machine).pipe(Effect.option)
      if (Option.isNone(actual) || !ComputerState.guards.Running(actual.value))
        return Option.none<MachineScreen>()
      return yield* state.machine.screen(row.value.machine).pipe(Effect.option)
    })
    /** The action permit protects the final takeover check and cancels idle stop until the action settles. */
    const executeReady = Effect.fn('ComputerStore.executeReady')(
      function* <A>(
        person: PersonId,
        action: (key: MachineKey) => Effect.Effect<A, MachineFailure>,
      ) {
        const key = yield* requireReady(state, person)
        yield* inactivity.activity(person)
        return yield* action(key).pipe(
          Effect.ensuring(
            inactivity.activity(person).pipe(
              Effect.andThen(inactivity.arm(person)),
              Effect.catch(() => Effect.logError('Computer activity could not be persisted.')),
            ),
          ),
        )
      },
      (effect, person) => state.lock(person).withPermit(effect),
    )
    /** Startup never waits while holding the action permit needed by the boot worker. */
    const execute = Effect.fn('ComputerStore.execute')(function* <A>(
      person: PersonId,
      action: (key: MachineKey) => Effect.Effect<A, MachineFailure>,
    ) {
      yield* inactivity.activity(person)
      yield* prepare(state, person).pipe(Effect.onError(() => inactivity.arm(person)))
      return yield* executeReady(person, action)
    })
    /** Commands, browser steps and desktop input share precisely the same readiness and idle policy. */
    const exec = Effect.fn('ComputerStore.exec')(
      (person: PersonId, input: { readonly command: string; readonly timeoutSeconds: number }) =>
        execute(person, (key) =>
          state.machine.exec({ key, command: input.command, timeoutSeconds: input.timeoutSeconds }),
        ),
    )
    const browse = Effect.fn('ComputerStore.browse')((person: PersonId, action: BrowserAction) =>
      execute(person, (key) => state.machine.browse({ key, action })),
    )
    const desktop = Effect.fn('ComputerStore.desktop')((person: PersonId, action: DesktopAction) =>
      execute(person, (key) => state.machine.desktop({ key, action })),
    )
    /** Manual lifecycle activity updates the same durable deadline as Vivid's actions. */
    const start = Effect.fn('ComputerStore.startActive')(function* (person: PersonId) {
      const computer = yield* state.start(person)
      yield* inactivity.activity(person)
      yield* inactivity.arm(person)
      return computer
    })
    const hold = Effect.fn('ComputerStore.holdActive')(function* (person: PersonId, held: boolean) {
      const computer = yield* state.hold(person, held)
      yield* inactivity.activity(person)
      yield* inactivity.arm(person)
      return computer
    })
    /** Explicit stop retires its idle timer as well as its boot worker. */
    const stop = Effect.fn('ComputerStore.stopActive')(function* (person: PersonId) {
      yield* inactivity.cancel(person)
      return yield* state.stop(person)
    })
    return ComputerStore.of({
      get: state.get,
      start,
      stop,
      hold,
      watching: inactivity.watching,
      access,
      screen,
      exec,
      browse,
      desktop,
    })
  }),
)

type ExecutionFailure = MachineFailure | ReadinessFailure | DatabaseInfrastructureError

/** Domain refusals keep useful sentences; database and provider details never reach a tool response. */
const executionReason = (failure: ExecutionFailure): string =>
  Match.value(failure).pipe(
    Match.tags({
      DatabaseFailure: () => 'The Computer record could not be read or updated.',
      DatabaseUnavailable: () => 'The Computer record could not be read or updated.',
      DatabaseConstraintViolation: () => 'The Computer record could not be read or updated.',
    }),
    Match.tag('ComputerHeld', () => 'the Person is using the Computer'),
    Match.tag(
      'ComputerProviderUnavailable',
      () => 'No Computer provider is configured on this installation.',
    ),
    Match.tag('ComputerStartFailed', ({ reason }) => `The Computer failed to start. ${reason}`),
    Match.tag('ComputerWakeTimedOut', () => 'The Computer did not become ready within 90 seconds.'),
    Match.tag('ComputerNotReady', ({ reason }) => reason),
    Match.orElse(machineFailureReason),
  )

/** Read-only browser steps follow the fixed policy; commands and input steps can change external state. */
const browserEffect = (action: BrowserAction) =>
  BrowserAction.match(action, {
    Open: () => 'read' as const,
    Read: () => 'read' as const,
    Screenshot: () => 'read' as const,
    Click: () => 'write' as const,
    Type: () => 'write' as const,
    Press: () => 'write' as const,
    Scroll: () => 'read' as const,
    Back: () => 'read' as const,
    Forward: () => 'read' as const,
    Wait: () => 'read' as const,
    OpenTab: () => 'read' as const,
    ShowTab: () => 'read' as const,
    CloseTab: () => 'read' as const,
  })

/** Gate decisions run before any command reaches the provider, and refusal is a wire outcome. */
export const computerRunCommand = Effect.fn('Computer.runCommand')(function* (
  actor: Actor,
  request: RunCommandRequest,
) {
  const store = yield* ComputerStore
  const gate = yield* Gate
  const action = ProposedAction.make({
    summary: request.summary,
    rationale: '',
    effect: 'write',
    target: ActionTarget.cases.Command.make({ command: request.command }),
  })
  const decision = yield* gate.check(actor, action, 'Ordinary')
  return yield* GateDecision.match(decision, {
    Blocked: Effect.fn('Computer.command.blocked')(
      ({ rule }: typeof GateDecision.cases.Blocked.Type): Effect.Effect<CommandOutcome> =>
        Effect.succeed(CommandOutcome.cases.Blocked.make({ rule })),
    ),
    ApprovalRequired: ({ approval }) =>
      Effect.succeed(
        CommandOutcome.cases.ApprovalRequired.make({
          approvalId: approval.id,
          summary: approval.action.summary,
        }),
      ),
    Allowed: () =>
      store
        .exec(actor.person.id, {
          command: request.command,
          timeoutSeconds: request.timeoutSeconds === undefined ? 30 : request.timeoutSeconds,
        })
        .pipe(
          Effect.map((result) => CommandOutcome.cases.Completed.make({ result })),
          Effect.catch((failure) =>
            Effect.succeed(
              CommandOutcome.cases.Unavailable.make({ reason: executionReason(failure) }),
            ),
          ),
        ),
  })
})

/** Browser actions use the same trust loop and recheck a Person's takeover immediately before execution. */
export const computerBrowse = Effect.fn('Computer.browse')(function* (
  actor: Actor,
  request: BrowseRequest,
) {
  const store = yield* ComputerStore
  const gate = yield* Gate
  const action = ProposedAction.make({
    summary: request.summary,
    rationale: '',
    effect: browserEffect(request.action),
    target: ActionTarget.cases.Browser.make({ action: request.action }),
  })
  const decision = yield* gate.check(actor, action, 'Ordinary')
  return yield* GateDecision.match(decision, {
    Blocked: ({ rule }) => Effect.succeed(BrowseOutcome.cases.Blocked.make({ rule })),
    ApprovalRequired: ({ approval }) =>
      Effect.succeed(
        BrowseOutcome.cases.ApprovalRequired.make({
          approvalId: approval.id,
          summary: approval.action.summary,
        }),
      ),
    Allowed: Effect.fn('Computer.browser.allowed')((): Effect.Effect<BrowseOutcome> =>
      store.browse(actor.person.id, request.action).pipe(
        Effect.map((result) => BrowseOutcome.cases.Completed.make({ result })),
        Effect.catch((failure) =>
          Effect.succeed(
            BrowseOutcome.cases.Unavailable.make({ reason: executionReason(failure) }),
          ),
        ),
      ),
    ),
  })
})

/** Looking, moving, scrolling and waiting are reads. Input that changes external state uses
 * precisely the browse input policy; the Gate still evaluates Never rules for read actions. */
const desktopEffect = (action: DesktopAction) =>
  DesktopAction.match(action, {
    Look: () => 'read' as const,
    Move: () => 'read' as const,
    Scroll: () => 'read' as const,
    Wait: () => 'read' as const,
    Click: () => 'write' as const,
    Drag: () => 'write' as const,
    Type: () => 'write' as const,
    Press: () => 'write' as const,
  })

/** The Gate precedes execution and the store rechecks takeover under its Person permit. */
export const computerDesktop = Effect.fn('Computer.desktop')(function* (
  actor: Actor,
  request: UseDesktopRequest,
) {
  const store = yield* ComputerStore
  const gate = yield* Gate
  const action = ProposedAction.make({
    summary: request.summary,
    rationale: '',
    effect: desktopEffect(request.action),
    target: ActionTarget.cases.Desktop.make({ action: request.action }),
  })
  const decision = yield* gate.check(actor, action, 'Ordinary')
  return yield* GateDecision.match(decision, {
    Blocked: ({ rule }) => Effect.succeed(DesktopOutcome.cases.Blocked.make({ rule })),
    ApprovalRequired: ({ approval }) =>
      Effect.succeed(
        DesktopOutcome.cases.ApprovalRequired.make({
          approvalId: approval.id,
          summary: approval.action.summary,
        }),
      ),
    Allowed: Effect.fn('Computer.desktop.allowed')((): Effect.Effect<DesktopOutcome> =>
      store.desktop(actor.person.id, request.action).pipe(
        Effect.map((view) => DesktopOutcome.cases.Completed.make({ view })),
        Effect.catch((failure) =>
          Effect.succeed(
            DesktopOutcome.cases.Unavailable.make({ reason: executionReason(failure) }),
          ),
        ),
      ),
    ),
  })
})

type ComputerTarget =
  | typeof ActionTarget.cases.Command.Type
  | typeof ActionTarget.cases.Browser.Type
  | typeof ActionTarget.cases.Desktop.Type

/** Approved actions run from their stored target once; a lost exec remains Unknown and is never retried. */
export const computerRunner = Effect.fn('Computer.runner')(function* (input: {
  readonly person: Person
  readonly target: ComputerTarget
}) {
  const store = yield* ComputerStore
  const result = yield* ActionTarget.match(input.target, {
    Command: ({ command }) =>
      store.exec(input.person.id, { command, timeoutSeconds: 30 }).pipe(
        Effect.map((receipt) =>
          receipt.exitCode === 0
            ? ActionOutcome.cases.Succeeded.make({ result: receipt.output.slice(0, 4000) })
            : ActionOutcome.cases.Failed.make({
                reason: `The command exited with code ${receipt.exitCode}.`,
              }),
        ),
      ),
    Browser: ({ action }) =>
      store
        .browse(input.person.id, action)
        .pipe(
          Effect.map((receipt) =>
            ActionOutcome.cases.Succeeded.make({ result: receipt.outline.slice(0, 4000) }),
          ),
        ),
    Desktop: ({ action }) =>
      store.desktop(input.person.id, action).pipe(
        Effect.map(() =>
          ActionOutcome.cases.Succeeded.make({
            result: 'The desktop action completed; look again to verify its outcome.',
          }),
        ),
      ),
    Connection: () =>
      Effect.succeed(
        ActionOutcome.cases.Failed.make({ reason: 'This action does not target the Computer.' }),
      ),
  }).pipe(
    Effect.catchTag('MachineExecutionUnknown', () =>
      Effect.succeed(ActionOutcome.cases.Unknown.make({})),
    ),
    Effect.catch((failure) =>
      Effect.succeed(ActionOutcome.cases.Failed.make({ reason: executionReason(failure) })),
    ),
  )
  return result
})
