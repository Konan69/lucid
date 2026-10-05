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
  type Stream,
} from 'effect'
import {
  ActionTarget,
  BrowserAction,
  DesktopAction,
  DeviceAccess,
  DesktopOutcome,
  type DesktopView,
  type UseDesktopRequest,
  BrowseTarget,
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
  BrowseResult,
  BrowserPicture,
} from '@vivid/contracts'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import { type Actor } from '../auth/access.ts'
import { Gate, GateDecision, ActionOutcome, ActionOrigin, actionOrigin } from '../approvals/gate.ts'
import { Changes, Topic } from '../live/changes.ts'
import {
  Machine,
  MachineKey,
  MachineState,
  MachineResponseInvalid,
  type MachineFailure,
  type MachineScreen,
  type MachineOutput,
} from './machine.ts'
import { BrowseAuthority, DeviceRegistry } from './device.ts'
import { requireThread } from '../threads/access.ts'
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
      MachineHeld: () =>
        'Vivid’s computer on this installation is already in use by another account.',
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
const wire = <State extends MachineState>(row: Stored, state: State) => ({
  id: row.id,
  heldByPerson: row.held,
  state,
})

/** Absence and disabled installation are distinct even before a record exists. */
const withoutRow = <State extends MachineState>(state: State) => ({
  id: null,
  state,
  heldByPerson: false,
})

export const ComputerAccess = Schema.TaggedUnion({
  Ready: { key: MachineKey },
  Unavailable: { reason: Schema.String },
})
export type ComputerAccess = typeof ComputerAccess.Type

/** Passive access reports status; only the permitted execution path may wake the Computer. */
const accessTo = (
  computer: { readonly heldByPerson: boolean; readonly state: MachineState },
  key: MachineKey,
): ComputerAccess => {
  if (computer.heldByPerson)
    return ComputerAccess.cases.Unavailable.make({ reason: 'the Person is using the Computer' })
  return MachineState.match(computer.state, {
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
const sameState = (row: Stored, state: MachineState): boolean =>
  MachineState.match(state, {
    Absent: () => false,
    Unavailable: () => false,
    Starting: ({ since }) => Stored.guards.starting(row) && row.since === since,
    Running: ({ since }) => Stored.guards.running(row) && row.since === since,
    Stopped: ({ since }) => Stored.guards.stopped(row) && row.since === since,
    Failed: ({ since, reason }) =>
      Stored.guards.failed(row) && row.since === since && row.reason === reason,
  })

/** Activity persistence owns millisecond epochs and restoration scans independently of lifecycle writes. */
const activityRows = (database: Database['Service']) => {
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
  return { active, touch }
}

/** All record reads and mutations are constrained by Person ownership, including background completions. */
const persistence = Effect.fn('ComputerStore.persistence')(function* (
  machine: Machine['Service'],
  lock: ReturnType<typeof personLocks>,
) {
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
  /** Every lifecycle write arms before publication; readers cannot observe an active state without its idle worker. */
  const commitState = Effect.fn('ComputerStore.commitState')(function* (
    person: PersonId,
    mutation: Effect.Effect<
      ReadonlyArray<typeof computers.$inferSelect>,
      DatabaseInfrastructureError
    >,
  ): Effect.fn.Return<ReadonlyArray<typeof computers.$inferSelect>, DatabaseInfrastructureError> {
    const written = yield* mutation
    if (written.length > 0) {
      yield* inactivity.arm(person)
      yield* publish(person)
    }
    return written
  })
  /** Compare the generation and state so a stale read or worker cannot overwrite a newer lifecycle transition. */
  const update = Effect.fn('ComputerStore.update')(function* (
    person: PersonId,
    before: Stored,
    state: MachineState,
  ) {
    const values = MachineState.match(state, {
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
    yield* commitState(
      person,
      database.run(
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
      ),
    )
    return yield* load(person)
  })
  /** Claim startup atomically; only the RETURNING owner may fork an ensure. */
  const starting = Effect.fn('ComputerStore.starting')(function* (person: PersonId) {
    const since = yield* Clock.currentTimeMillis
    const claimed = yield* commitState(
      person,
      database.run(
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
      ),
    )
    const row = claimed[0]
    if (row === undefined) return Option.none<Stored>()
    return Option.some(yield* decode(row))
  })
  /** Holding an absent Computer does not create one. Keyboard ownership is independent of workspace. */
  const hold = Effect.fn('ComputerStore.holdRow')(function* (person: PersonId, held: boolean) {
    const rows = yield* database.run(
      database.update(computers).set({ held }).where(eq(computers.personId, person)).returning(),
    )
    if (rows.length > 0) yield* publish(person)
  })
  const { active, touch } = activityRows(database)
  const inactivity = yield* idle({ rows: { load, update, active, touch }, machine, lock })
  return { load, update, starting, hold, active, touch, inactivity }
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
  /** Passive observations neither wake a Computer nor extend its inactivity deadline. */
  readonly probe: (
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
  /**
   * The Person's Computer for work of Vivid's own that lasts: a program. It is woken and checked
   * like any action, and it stays awake until the scope closes. Unlike an action it does not hold
   * the Computer: a program asks for commands and browser steps while it runs, and each of those
   * takes the Computer in the ordinary way. A Person who takes the Computer over after this is
   * not interrupted by it; the program's later steps are refused as theirs always are.
   */
  readonly attach: (
    person: PersonId,
  ) => Effect.Effect<
    ComputerAttachment,
    StoreError | MachineFailure | ReadinessFailure,
    Scope.Scope
  >
}

/** A running Computer with its machine already chosen; no caller of this names a machine. */
export interface ComputerAttachment {
  readonly follow: (input: {
    readonly command: string
    readonly timeoutSeconds: number
  }) => Stream.Stream<MachineOutput, MachineFailure>
  readonly write: (input: {
    readonly path: string
    readonly content: string
  }) => Effect.Effect<void, MachineFailure>
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

/** The same persisted reconciliation projects Person viewer reads and screen-free action observations. */
const observations = (
  rows: Persistence,
  machine: Machine['Service'],
  pending: ReadonlySet<PersonId>,
) => {
  /** Provider absence maps to stopped only for an existing row, never an invented running address. */
  const read = Effect.fn('ComputerStore.read')(function* <State extends MachineState>(
    person: PersonId,
    observe: (key: MachineKey) => Effect.Effect<State, MachineFailure>,
  ) {
    const row = yield* rows.load(person)
    const key = Option.match(row, {
      onNone: () => computerMachineKey(person),
      onSome: (value) => value.machine,
    })
    const recordedSince = Option.isSome(row) ? row.value.since : yield* Clock.currentTimeMillis
    const reported = yield* observe(key).pipe(
      Effect.catch((failure) =>
        Effect.succeed(
          ComputerState.cases.Failed.make({
            since: recordedSince,
            reason: machineFailureReason(failure),
          }),
        ),
      ),
    )
    if (MachineState.guards.Unavailable(reported)) return withoutRow(reported)
    if (Option.isNone(row)) return withoutRow(ComputerState.cases.Absent.make({}))
    if (pending.has(person) && Stored.guards.starting(row.value))
      return wire(row.value, ComputerState.cases.Starting.make({ since: row.value.since }))
    if (Stored.guards.failed(row.value) && !MachineState.guards.Running(reported))
      return wire(
        row.value,
        ComputerState.cases.Failed.make({ since: row.value.since, reason: row.value.reason }),
      )
    const actual = MachineState.guards.Absent(reported)
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
  /** Person reads include the cached viewer; action checks carry lifecycle facts only. */
  const get = Effect.fn('ComputerStore.get')((person: PersonId) =>
    read(person, (key) => machine.status(key)).pipe(Effect.map((value) => Computer.make(value))),
  )
  const inspect = Effect.fn('ComputerStore.inspect')((person: PersonId) =>
    read(person, (key) => machine.inspect(key)),
  )
  return { get, inspect }
}

/** Scoped lifecycle workers and Person locks order start/stop/hold/execution without tying startup to an RPC fiber. */
const lifecycle = Effect.fn('ComputerStore.lifecycle')(function* () {
  const machine = yield* Machine
  const lock = personLocks()
  const rows = yield* persistence(machine, lock)
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
  const { get, inspect } = observations(rows, machine, pending)
  /** Start returns the persisted starting receipt before its scope-owned worker acquires the lifecycle permit. */
  const begin = Effect.fn('ComputerStore.begin')(
    function* (person: PersonId) {
      const current = yield* inspect(person)
      if (MachineState.isAnyOf(['Running', 'Unavailable'])(current.state)) return current
      pending.add(person)
      const claim = MachineState.guards.Starting(current.state)
        ? rows.load(person)
        : rows.starting(person)
      const row = yield* claim.pipe(
        Effect.onError(() => forget(person)),
        Effect.onInterrupt(() => forget(person)),
      )
      if (Option.isNone(row)) {
        yield* forget(person)
        return yield* inspect(person)
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
    if (pending.has(person)) return yield* inspect(person)
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
  /** Takeover is an atomic row write independent of the action permit. The in-flight tool may finish,
   * while the next action's final readiness check sees the hold. The response must not queue either. */
  const hold = Effect.fn('ComputerStore.hold')(function* (person: PersonId, held: boolean) {
    yield* rows.hold(person, held)
    return yield* get(person)
  })
  return { get, inspect, start, stop, hold, lock, rows, machine, workers }
})

/** Actions may wake absent/stopped machines once; failed starts require an explicit Person decision.
 * Starting uses the same provider ensure receipt, including a persisted startup after a restart. */
const prepare = Effect.fn('ComputerStore.prepare')(
  function* (state: Effect.Success<ReturnType<typeof lifecycle>>, person: PersonId) {
    const current = yield* state.inspect(person)
    if (current.heldByPerson) return
    if (MachineState.isAnyOf(['Absent', 'Stopped', 'Starting'])(current.state))
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
  const computer = yield* state.inspect(person)
  if (computer.heldByPerson) return yield* Effect.fail(new ComputerHeld({ person }))
  const refusal = MachineState.match<
    Option.Option<ComputerProviderUnavailable | ComputerStartFailed>
  >(computer.state, {
    Unavailable: () => Option.some(new ComputerProviderUnavailable({ person })),
    Failed: ({ reason }) => Option.some(new ComputerStartFailed({ person, reason })),
    Absent: () => Option.none(),
    Starting: () => Option.none(),
    Running: () => Option.none(),
    Stopped: () => Option.none(),
  })
  if (Option.isSome(refusal)) return yield* Effect.fail(refusal.value)
  const ready = accessTo(computer, computerMachineKey(person))
  if (ComputerAccess.guards.Unavailable(ready))
    return yield* Effect.fail(new ComputerNotReady({ reason: ready.reason }))
  const row = yield* state.rows.load(person)
  if (Option.isNone(row))
    return yield* Effect.fail(new ComputerNotReady({ reason: 'The Computer is absent.' }))
  // Provider observation can await I/O while takeover commits; use the latest durable hold before dispatch.
  if (row.value.held) return yield* Effect.fail(new ComputerHeld({ person }))
  return row.value.machine
})

/** One scoped timer owns each Computer's idle deadline. Activity cancels it before updating time.
 * Watches are counted by subscription lifetime, never by repeated status reads. Keyboard ownership also suppresses stop. */
const idle = Effect.fn('ComputerStore.idle')(function* (state: {
  readonly rows: {
    readonly load: (
      person: PersonId,
    ) => Effect.Effect<Option.Option<Stored>, DatabaseInfrastructureError>
    readonly update: (
      person: PersonId,
      before: Stored,
      state: MachineState,
    ) => Effect.Effect<Option.Option<Stored>, DatabaseInfrastructureError>
    readonly active: () => Effect.Effect<ReadonlyArray<Stored>, DatabaseInfrastructureError>
    readonly touch: (person: PersonId) => Effect.Effect<void, DatabaseInfrastructureError>
  }
  readonly machine: Machine['Service']
  readonly lock: ReturnType<typeof personLocks>
}) {
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

/**
 * Presence, not the action permit, is what a program holds: it keeps the idle stop away as a
 * watching Person does, and the permit is taken only for the final takeover check. Waking that
 * fails puts the idle deadline back, as it does for an action.
 */
const attached = Effect.fn('ComputerStore.attach')(function* (
  state: Effect.Success<ReturnType<typeof lifecycle>>,
  person: PersonId,
) {
  const inactivity = state.rows.inactivity
  yield* inactivity.activity(person)
  yield* prepare(state, person).pipe(
    Effect.onError(() =>
      inactivity
        .arm(person)
        .pipe(Effect.catch(() => Effect.logError('Computer idle deadline could not be restored.'))),
    ),
  )
  yield* inactivity.watching(person)
  const key = yield* state.lock(person).withPermit(requireReady(state, person))
  const attachment: ComputerAttachment = {
    follow: (input) =>
      state.machine.follow({ key, command: input.command, timeoutSeconds: input.timeoutSeconds }),
    write: (input) => state.machine.write({ key, path: input.path, content: input.content }),
  }
  return attachment
})

const decodeBrowserPicture = Schema.decodeUnknownEffect(BrowserPicture)

/** The provider’s browser operation returns an outline only. Cloud Screenshot therefore captures
 * Vivid’s whole desktop through the public Look API; it is not a browser-page crop. Both reads
 * run inside the caller’s single takeover permit, preserving the existing cloud behavior. */
const browserReceipt = Effect.fn('ComputerStore.browserReceipt')(function* (
  machine: Machine['Service'],
  key: MachineKey,
  action: BrowserAction,
) {
  if (!BrowserAction.guards.Screenshot(action)) return yield* machine.browse({ key, action })
  const result = yield* machine.browse({ key, action: BrowserAction.cases.Read.make({}) })
  const view = yield* machine.desktop({ key, action: DesktopAction.cases.Look.make({}) })
  const picture = yield* decodeBrowserPicture(view.picture).pipe(
    Effect.mapError(() => new MachineResponseInvalid({ operation: 'browser screenshot' })),
  )
  // Built field by field: `result` is a schema value, and a spread would drop its prototype.
  return BrowseResult.make({
    address: result.address,
    title: result.title,
    outline: result.outline,
    truncated: result.truncated,
    tabs: result.tabs,
    picture,
  })
})

/** Capture provider and database dependencies once; callers need only the Computer authority. */
export const computerStoreLayer = Layer.effect(
  ComputerStore,
  Effect.gen(function* () {
    const state = yield* lifecycle()
    const inactivity = state.rows.inactivity
    /** Resolve provider identity only after a current lifecycle and keyboard-ownership check. */
    const access = Effect.fn('ComputerStore.access')(function* (person: PersonId) {
      const row = yield* state.rows.load(person)
      const computer = yield* state.inspect(person)
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
      const actual = yield* state.machine.inspect(row.value.machine).pipe(Effect.option)
      if (Option.isNone(actual) || !MachineState.guards.Running(actual.value))
        return Option.none<MachineScreen>()
      return yield* state.machine.screen(row.value.machine).pipe(Effect.option)
    })
    /** The action permit protects the final takeover check and cancels idle stop until the action settles. */
    const executeReady = Effect.fn('ComputerStore.executeReady')(
      function* <A>(
        person: PersonId,
        action: (key: MachineKey) => Effect.Effect<A, MachineFailure>,
      ) {
        yield* inactivity.activity(person)
        const key = yield* requireReady(state, person)
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
    /** Idle cleanup must preserve the original readiness failure even if its database write fails. */
    const recoverIdle = Effect.fn('ComputerStore.recoverIdle')((person: PersonId) =>
      inactivity
        .arm(person)
        .pipe(Effect.catch(() => Effect.logError('Computer idle deadline could not be restored.'))),
    )
    /** Startup never waits while holding the action permit needed by the boot worker. */
    const execute = Effect.fn('ComputerStore.execute')(function* <A>(
      person: PersonId,
      action: (key: MachineKey) => Effect.Effect<A, MachineFailure>,
    ) {
      yield* inactivity.activity(person)
      yield* prepare(state, person).pipe(Effect.onError(() => recoverIdle(person)))
      return yield* executeReady(person, action)
    })
    /** Commands, browser steps and desktop input share precisely the same readiness and idle policy. */
    const exec = Effect.fn('ComputerStore.exec')(
      (person: PersonId, input: { readonly command: string; readonly timeoutSeconds: number }) =>
        execute(person, (key) =>
          state.machine.exec({ key, command: input.command, timeoutSeconds: input.timeoutSeconds }),
        ),
    )
    /** Hold the same permit as takeover and idle stop, but do not prepare or record activity.
     * Context reads must never start a machine or indefinitely postpone its idle shutdown. */
    const probe = Effect.fn('ComputerStore.probe')(
      function* (
        person: PersonId,
        input: { readonly command: string; readonly timeoutSeconds: number },
      ) {
        const key = yield* requireReady(state, person)
        return yield* state.machine.exec({
          key,
          command: input.command,
          timeoutSeconds: input.timeoutSeconds,
        })
      },
      (effect, person) => state.lock(person).withPermit(effect),
    )
    /** Both outline and image run under the same takeover permit. */
    const browse = Effect.fn('ComputerStore.browse')((person: PersonId, action: BrowserAction) =>
      execute(person, (key) => browserReceipt(state.machine, key, action)),
    )
    const desktop = Effect.fn('ComputerStore.desktop')((person: PersonId, action: DesktopAction) =>
      execute(person, (key) => state.machine.desktop({ key, action })),
    )
    const attach = (person: PersonId) => attached(state, person)
    /** Manual lifecycle activity updates the same durable deadline as Vivid's actions. */
    const start = Effect.fn('ComputerStore.startActive')(function* (person: PersonId) {
      const computer = yield* state.start(person)
      yield* inactivity.activity(person)
      yield* inactivity.arm(person)
      if (MachineState.guards.Running(computer.state)) return yield* state.get(person)
      return Computer.make({
        id: computer.id,
        heldByPerson: computer.heldByPerson,
        state: computer.state,
      })
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
      probe,
      browse,
      desktop,
      attach,
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

/** Only known provider/readiness refusals become tool outcomes; database failures remain visible. */
const executionRefusals = <A>(
  handle: (failure: MachineFailure | ReadinessFailure) => Effect.Effect<A>,
) => {
  return {
    MachineUnavailable: handle,
    MachineNotRunning: handle,
    MachineOperationFailed: handle,
    MachineResponseInvalid: handle,
    MachineInputInvalid: handle,
    BrowserAddressRefused: handle,
    BrowserStepFailed: handle,
    MachineConfigurationInvalid: handle,
    MachineAuthenticationFailed: handle,
    MachineCreationUnresolved: handle,
    MachineRequestRejected: handle,
    MachinePersistenceFailed: handle,
    MachineHeld: handle,
    MachineCapabilityUnavailable: handle,
    ComputerHeld: handle,
    ComputerProviderUnavailable: handle,
    ComputerStartFailed: handle,
    ComputerNotReady: handle,
    ComputerWakeTimedOut: handle,
  }
}

/** Navigation stays read by policy, including credentialed GETs that can have side effects.
 * Desktop refuses private-network addresses and the Person has an explicit Stop. Closing their
 * tab destroys personal state and requires permission; Vivid's contained tab behavior is unchanged. */
const browserEffect = (action: BrowserAction, target: BrowseTarget) =>
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
    CloseTab: () => (BrowseTarget.guards.Person(target) ? ('write' as const) : ('read' as const)),
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
  return yield* GateDecision.match<Effect.Effect<CommandOutcome, DatabaseInfrastructureError>>(
    decision,
    {
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
            Effect.catchTag('MachineExecutionUnknown', () =>
              Effect.succeed(CommandOutcome.cases.OutcomeUnknown.make({})),
            ),
            Effect.catchTags(
              executionRefusals((failure) =>
                Effect.succeed(
                  CommandOutcome.cases.Unavailable.make({ reason: executionReason(failure) }),
                ),
              ),
            ),
          ),
    },
  )
})

/** Device availability is explicit and never grants permission to use the cloud Computer instead. */
const personAvailability = Effect.fn('Computer.personAvailability')(function* (personId: PersonId) {
  const devices = yield* (yield* DeviceRegistry).list(personId)
  if (devices.length > 0 && !devices.some((device) => DeviceAccess.guards.Allowed(device.access)))
    return Option.some(BrowseOutcome.cases.NotAllowed.make({}))
  return yield* (yield* DeviceRegistry).requireConnected(personId).pipe(
    Effect.as(Option.none<BrowseOutcome>()),
    Effect.catchTag('NoDeviceConnected', () =>
      Effect.succeed(Option.some(BrowseOutcome.cases.NotConnected.make({}))),
    ),
  )
})

/** Device transport failures have safe fixed meanings; unknown dispatch never permits replay. */
const personBrowse = Effect.fn('Computer.personBrowse')(function* (input: {
  readonly person: Person
  readonly origin: ActionOrigin
  readonly action: BrowserAction
  readonly authority: BrowseAuthority
}) {
  if (!ActionOrigin.guards.Run(input.origin)) return BrowseOutcome.cases.RunRequired.make({})
  const unavailable = yield* personAvailability(input.person.id)
  if (Option.isSome(unavailable)) return unavailable.value
  return yield* (yield* DeviceRegistry)
    .browse({
      personId: input.person.id,
      threadId: input.origin.threadId,
      runId: input.origin.runId,
      action: input.action,
      authority: input.authority,
    })
    .pipe(
      Effect.catchTag('NoDeviceConnected', () =>
        Effect.succeed(BrowseOutcome.cases.NotConnected.make({})),
      ),
      Effect.catchTag('DeviceBusy', () => Effect.succeed(BrowseOutcome.cases.Busy.make({}))),
      Effect.catchTag('NoActingRun', () =>
        Effect.succeed(BrowseOutcome.cases.RunRequired.make({})),
      ),
    )
})

/** Personal page contents enter durable history; only the Thread’s real private audience avoids
 * a disclosure Approval. Cloud results retain the existing ordinary exposure policy. */
const browserExposure = Effect.fn('Computer.browserExposure')(function* (
  actor: Actor,
  target: BrowseTarget,
) {
  if (BrowseTarget.guards.Vivid(target) || Option.isNone(actor.threadId)) return 'Ordinary' as const
  const thread = yield* requireThread(actor.threadId.value, actor.person.id)
  return thread.audience === 'private' ? ('Ordinary' as const) : ('PersonalInShared' as const)
})

/** Both browser targets use the same Gate; the Person target dispatches only to their allowed Device. */
export const computerBrowse = Effect.fn('Computer.browse')(function* (
  actor: Actor,
  request: BrowseRequest,
) {
  if (BrowseTarget.guards.Person(request.target)) {
    const unavailable = yield* personAvailability(actor.person.id)
    if (Option.isSome(unavailable)) return unavailable.value
  }
  const store = yield* ComputerStore
  const gate = yield* Gate
  const action = ProposedAction.make({
    summary: request.summary,
    rationale: '',
    effect: browserEffect(request.action, request.target),
    target: ActionTarget.cases.Browser.make({ action: request.action, target: request.target }),
  })
  const origin = yield* actionOrigin(actor)
  if (BrowseTarget.guards.Person(request.target) && !ActionOrigin.guards.Run(origin))
    return BrowseOutcome.cases.RunRequired.make({})
  const decision = yield* gate.check(actor, action, yield* browserExposure(actor, request.target))
  return yield* GateDecision.match(decision, {
    Blocked: ({ rule }) => Effect.succeed(BrowseOutcome.cases.Blocked.make({ rule })),
    ApprovalRequired: ({ approval }) =>
      Effect.succeed(
        BrowseOutcome.cases.ApprovalRequired.make({
          approvalId: approval.id,
          summary: approval.action.summary,
        }),
      ),
    Allowed: Effect.fn('Computer.browser.allowed')(() =>
      BrowseTarget.guards.Person(request.target)
        ? personBrowse({
            person: actor.person,
            origin,
            action: request.action,
            authority: BrowseAuthority.cases.Acting.make({}),
          })
        : store.browse(actor.person.id, request.action).pipe(
            Effect.map((result) => BrowseOutcome.cases.Completed.make({ result })),
            Effect.catchTag('MachineExecutionUnknown', () =>
              Effect.succeed(BrowseOutcome.cases.OutcomeUnknown.make({})),
            ),
            Effect.catchTags(
              executionRefusals((failure) =>
                Effect.succeed(
                  BrowseOutcome.cases.Unavailable.make({ reason: executionReason(failure) }),
                ),
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
  return yield* GateDecision.match<Effect.Effect<DesktopOutcome, DatabaseInfrastructureError>>(
    decision,
    {
      Blocked: ({ rule }) => Effect.succeed(DesktopOutcome.cases.Blocked.make({ rule })),
      ApprovalRequired: ({ approval }) =>
        Effect.succeed(
          DesktopOutcome.cases.ApprovalRequired.make({
            approvalId: approval.id,
            summary: approval.action.summary,
          }),
        ),
      Allowed: Effect.fn('Computer.desktop.allowed')(() =>
        store.desktop(actor.person.id, request.action).pipe(
          Effect.map((view) => DesktopOutcome.cases.Completed.make({ view })),
          Effect.catchTag('MachineExecutionUnknown', () =>
            Effect.succeed(DesktopOutcome.cases.OutcomeUnknown.make({})),
          ),
          Effect.catchTags(
            executionRefusals((failure) =>
              Effect.succeed(
                DesktopOutcome.cases.Unavailable.make({ reason: executionReason(failure) }),
              ),
            ),
          ),
        ),
      ),
    },
  )
})

type ComputerTarget =
  | typeof ActionTarget.cases.Command.Type
  | typeof ActionTarget.cases.Browser.Type
  | typeof ActionTarget.cases.Desktop.Type

/** Approval receipts preserve takeover and uncertainty without persisting private page contents. */
const approvedBrowse = (outcome: BrowseOutcome): ActionOutcome =>
  BrowseOutcome.match<ActionOutcome>(outcome, {
    Completed: () =>
      ActionOutcome.cases.Succeeded.make({ result: 'The browser action completed.' }),
    OutcomeUnknown: () => ActionOutcome.cases.Unknown.make({}),
    Stopped: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'The Person took control. Do not retry by yourself.',
      }),
    NotConnected: () =>
      ActionOutcome.cases.Failed.make({ reason: 'The Person’s desktop app is not connected.' }),
    AddressRefused: () =>
      ActionOutcome.cases.Failed.make({
        reason:
          'That page or address cannot be opened on the Person’s computer. Use a public web address.',
      }),
    NotAllowed: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'The Person has not allowed access to their computer.',
      }),
    Busy: () => ActionOutcome.cases.Failed.make({ reason: 'The Person’s computer is busy.' }),
    PageGone: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'The page is gone. Ask the Person to open it again.',
      }),
    Unsupported: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'The Person’s computer does not support this browser action.',
      }),
    RunRequired: () =>
      ActionOutcome.cases.Failed.make({
        reason: 'This action was not sent because its proposing work is no longer active.',
      }),
    Unavailable: ({ reason }) => ActionOutcome.cases.Failed.make({ reason }),
    Blocked: ({ rule }) => ActionOutcome.cases.Failed.make({ reason: rule }),
    ApprovalRequired: () =>
      ActionOutcome.cases.Failed.make({ reason: 'This action still needs approval.' }),
  })

/** Expected machine refusals settle an Approval as Failed with their domain-specific explanation. */
const failedExecution = (failure: MachineFailure | ReadinessFailure) =>
  Effect.succeed(ActionOutcome.cases.Failed.make({ reason: executionReason(failure) }))

/** Device errors escape only before its ledger/send boundary; cloud database writes likewise
 * precede provider execution (post-action activity failures are logged inside executeReady).
 * Record the infrastructure tag while allowing Approvals.decide to durably settle not-sent.
 * A failed settlement write still propagates from the Approval owner and cannot be hidden here. */
const notSent = Effect.fn('Computer.notSent')(function* (failure: DatabaseInfrastructureError) {
  yield* Effect.logError('Approved Computer action was not sent', failure._tag)
  return ActionOutcome.cases.Failed.make({
    reason: 'Nothing was sent, because the Computer record could not be read or updated.',
  })
})

/** Approved actions run from their stored target once; a lost exec remains Unknown and is never retried. */
export const computerRunner = Effect.fn('Computer.runner')(function* (input: {
  readonly person: Person
  readonly target: ComputerTarget
  readonly origin: ActionOrigin
}) {
  const store = yield* ComputerStore
  const result = yield* ActionTarget.match<
    Effect.Effect<ActionOutcome, ExecutionFailure, DeviceRegistry>
  >(input.target, {
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
    Browser: ({ action, target }) =>
      BrowseTarget.guards.Person(target)
        ? personBrowse({
            person: input.person,
            origin: input.origin,
            action,
            authority: BrowseAuthority.cases.Approved.make({}),
          }).pipe(Effect.map(approvedBrowse))
        : store
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
    Effect.catchTags(executionRefusals(failedExecution)),
    Effect.catchTags({
      DatabaseFailure: notSent,
      DatabaseUnavailable: notSent,
      DatabaseConstraintViolation: notSent,
    }),
  )
  return result
})
