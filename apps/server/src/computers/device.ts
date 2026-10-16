import * as NodeCrypto from 'node:crypto'
import { and, eq, lte, gt, ne, sql } from 'drizzle-orm'
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from 'effect'
import {
  BrowseOutcome,
  DeviceWork,
  DeviceAbility,
  WindowOutcome,
  WindowAction,
  type ReportDeviceStopRequest,
  RunState,
  DatabaseFailure,
  Device,
  DEVICE_ASKING_MILLIS,
  DeviceAccess,
  DeviceAnswer,
  DeviceId,
  DeviceName,
  DevicePresence,
  DeviceRequest,
  DeviceRequestId,
  Forbidden,
  NoDeviceConnected,
  NotFound,
  type AnswerDeviceRequest,
  type BrowserAction,
  type EnrolDeviceRequest,
  type InstallationId,
  type PersonId,
  type SessionId,
  type ThreadId,
  RunId,
} from '@vivid/contracts'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { NoActingRun, admittedRunState } from '../threads/runs.ts'
import { stopPersonRun } from '../threads/stop.ts'
import { Runtime } from '../runtime/client.ts'
import { DeviceReceipt, DeviceSubscriptionId, receiptOf } from './receipt.ts'
import { deviceRequests, devices } from './tables.ts'

/**
 * How long one request may take from the moment a Run asks, in milliseconds. It covers everything:
 * waiting for an earlier request to finish, the trip to the computer and the action itself. It is
 * Vivid's own budget for a request that crosses the network; the reference keeps its model loop
 * on the same machine and so has no such hop
 * (artifacts/night/reviews/chatgpt-latest.md, section 2, "Routing").
 */
const REQUEST_BUDGET_MILLIS = 30_000

/**
 * How long a request waits for the computer to finish an earlier one before giving up. Shorter
 * than the budget so a request that does get its turn still has time to be carried out.
 */
const TURN_WAIT_MILLIS = 10_000

/** The Person's computer is still carrying out an earlier request, and this one stopped waiting. */
export class DeviceBusy extends Schema.TaggedError<DeviceBusy>()(
  'DeviceBusy',
  { device: DeviceId },
  { title: 'The Person’s computer is busy with an earlier request' },
) {}

/** The exact admitted Run settled while its work waited; nothing was sent. */
class RunNotWorking extends Schema.TaggedError<RunNotWorking>()(
  'RunNotWorking',
  { runId: RunId },
  { title: 'The Run has ended' },
) {}

/** One desktop app listening: the session that opened it, where its requests go, and its end. */
interface Subscription {
  readonly id: DeviceSubscriptionId
  readonly device: DeviceId
  readonly sessionId: SessionId
  readonly ability: DeviceAbility
  readonly windowRuns: Set<RunId>
  readonly requests: Queue.Queue<DeviceRequest>
  readonly closed: Deferred.Deferred<void>
}

/** A request that was sent and is waiting, with the link it went out on. */
interface Pending {
  readonly subscription: Subscription
  readonly request: typeof DeviceRequest.cases.Act.Type
  readonly answer: Deferred.Deferred<DeviceAnswer>
}

/**
 * On whose word an action is sent to the Person's computer: the Run acting now, or the Person
 * who approved what a Run proposed. See `dispatchRun` for what each one requires of the Run.
 */
export const BrowseAuthority = Schema.TaggedUnion({ Acting: {}, Approved: {} })
export type BrowseAuthority = typeof BrowseAuthority.Type

export interface DeviceService {
  /** Records this installation as one of the Person's computers. Repeating it returns the same one. */
  readonly enrol: (
    personId: PersonId,
    request: EnrolDeviceRequest,
  ) => Effect.Effect<Device, DatabaseInfrastructureError>
  /** The Person's computers, oldest first, each with its access and whether it is listening. */
  readonly list: (
    personId: PersonId,
  ) => Effect.Effect<ReadonlyArray<Device>, DatabaseInfrastructureError>
  /** Which of these computers are waiting to be allowed with their desktop app open now. */
  readonly asking: (list: ReadonlyArray<Device>) => Effect.Effect<ReadonlyArray<DeviceId>>
  /** Lets Vivid use this computer and, in the same write, no other computer of this Person. */
  readonly allow: (
    personId: PersonId,
    id: DeviceId,
  ) => Effect.Effect<Device, NotFound | DatabaseInfrastructureError>
  /** Takes access away and ends the computer's link at once. */
  readonly revoke: (
    personId: PersonId,
    id: DeviceId,
  ) => Effect.Effect<Device, NotFound | DatabaseInfrastructureError>
  /** Whether the Person has an allowed computer listening right now. */
  readonly requireConnected: (
    personId: PersonId,
  ) => Effect.Effect<void, NoDeviceConnected | DatabaseInfrastructureError>
  /** The requests for one computer, for as long as the caller's scope lives. */
  readonly watch: (input: {
    readonly personId: PersonId
    readonly sessionId: SessionId
    readonly device: DeviceId
    readonly installation: InstallationId
    readonly ability: DeviceAbility
  }) => Effect.Effect<
    Stream.Stream<DeviceRequest>,
    NotFound | Forbidden | DatabaseInfrastructureError,
    Scope.Scope
  >
  /** Sends one action to the Person's computer for the Run that proposed it in this Thread. */
  readonly browse: (input: {
    readonly personId: PersonId
    readonly threadId: ThreadId
    readonly runId: RunId
    readonly action: BrowserAction
    readonly authority: BrowseAuthority
  }) => Effect.Effect<
    BrowseOutcome,
    NoDeviceConnected | NoActingRun | DeviceBusy | DatabaseInfrastructureError
  >
  /** Device allowance is the whole permission: their own machine, which they allowed. */
  readonly window: (input: {
    personId: PersonId
    threadId: ThreadId
    runId: RunId
    action: WindowAction
  }) => Effect.Effect<WindowOutcome, DatabaseInfrastructureError>
  /** Ends a native turn once on its original Device link; offline Devices use their own idle timeout. */
  readonly ended: (runId: RunId) => Effect.Effect<void>
  /** Desktop Stop must prove Device, installation and Run ownership before runtime abort. */
  readonly reportStop: (
    personId: PersonId,
    input: ReportDeviceStopRequest,
  ) => Effect.Effect<
    void,
    | NotFound
    | Forbidden
    | DatabaseInfrastructureError
    | import('@vivid/contracts').RuntimeUnavailable,
    Runtime
  >
  readonly answer: (
    personId: PersonId,
    sessionId: SessionId,
    input: AnswerDeviceRequest,
  ) => Effect.Effect<
    void,
    | Forbidden
    | DatabaseInfrastructureError
    | NotFound
    | import('@vivid/contracts').RuntimeUnavailable,
    Runtime
  >
}

/**
 * A Person's own computers, and the link Vivid reaches the allowed one through.
 *
 * The model is the reference desktop app's: the app on a Person's PC registers that PC, the PC
 * appears in a list with a name, an access state and whether it is connected, the Person grants
 * and takes away access explicitly, granting one computer drops the others, and the PC dials out
 * so nothing has to reach into it (artifacts/night/reviews/chatgpt-latest.md, section 1, "Local PC
 * used by the dot", and section 4, "Computers list" and "Attach/detach").
 *
 * What is Vivid's own: a Run lives on the server, so a request crosses the network and needs a
 * deadline and a ledger; and a Thread can be shared, so a request is tied to the Run that asked
 * and refused unless that Run is acting for the computer's own Person.
 *
 * Who is listening is kept in this process. The server must stay at one replica until presence
 * is shared and browse requests route to the replica holding the desktop socket; otherwise a
 * second replica reports Offline and cannot deliver work to a connected computer.
 */
export class DeviceRegistry extends Context.Service<DeviceRegistry, DeviceService>()(
  'vivid/DeviceRegistry',
) {}

type DatabaseService = Database['Service']
type DeviceRow = typeof devices.$inferSelect

const decodeStoredDevice = decodeStored(
  Schema.Struct({ id: DeviceId, name: DeviceName, access: DeviceAccess }),
  'Device',
)
const decodeReceipt = decodeStored(DeviceReceipt, 'Device receipt')
const encodeReceipt = encodeStored(DeviceReceipt, 'Device receipt')

/** The two columns an access state is stored in. The only place the union becomes columns. */
const accessColumns = (access: DeviceAccess) => ({
  access: access._tag,
  accessSince: access.since,
})

/** What the Run is told. Words for the model: they name the Person's computer and nothing inside it. */
const outcomeOf = (answer: DeviceAnswer): BrowseOutcome =>
  DeviceAnswer.match<BrowseOutcome>(answer, {
    Done: ({ result }) => BrowseOutcome.cases.Completed.make({ result }),
    // The Device’s legacy NotAllowed literal means an address/page refusal, not access permission.
    // Keep the wire vocabulary compatible with desktop while making the product outcome precise.
    Refused: ({ reason }) =>
      Match.value(reason).pipe(
        Match.when('NotAllowed', () => BrowseOutcome.cases.AddressRefused.make({})),
        Match.when('Stopped', () => BrowseOutcome.cases.Stopped.make({})),
        Match.when('PageGone', () => BrowseOutcome.cases.PageGone.make({})),
        Match.when('Unsupported', () => BrowseOutcome.cases.Unsupported.make({})),
        Match.exhaustive,
      ),
    Did: () => BrowseOutcome.cases.OutcomeUnknown.make({}),
    Declined: () => BrowseOutcome.cases.OutcomeUnknown.make({}),
    Failed: () =>
      BrowseOutcome.cases.Unavailable.make({
        reason: 'The Person’s computer could not complete this action.',
      }),
  })

/**
 * Who is listening. One link per Device: a second link for the same Device takes over and the
 * first one ends, so a connection that died without saying so cannot shadow the app that came
 * back, and a request never has two places it might go.
 */
const makePresence = (links: Map<DeviceId, Subscription>, knocks: Map<DeviceId, number>) => {
  /** Ending a link is one signal. Its stream stops and every request waiting on it settles. */
  const close = (subscription: Subscription) => Deferred.succeed(subscription.closed, undefined)

  const open = Effect.fn('Device.open')(function* (
    device: DeviceId,
    sessionId: SessionId,
    ability: DeviceAbility,
  ) {
    const subscription: Subscription = {
      id: DeviceSubscriptionId.make(NodeCrypto.randomUUID()),
      device,
      sessionId,
      ability,
      windowRuns: new Set(),
      requests: yield* Queue.unbounded<DeviceRequest>(),
      closed: yield* Deferred.make<void>(),
    }
    const replaced = links.get(device)
    links.set(device, subscription)
    if (replaced !== undefined) yield* close(replaced)
    return subscription
  })

  /** The caller went away. A link that was already replaced must not remove its successor. */
  const release = Effect.fn('Device.release')(function* (subscription: Subscription) {
    if (links.get(subscription.device) === subscription) links.delete(subscription.device)
    yield* close(subscription)
  })

  /** Access was taken away: whoever is listening for this Device stops now. */
  const end = Effect.fn('Device.end')(function* (device: DeviceId) {
    const subscription = links.get(device)
    if (subscription === undefined) return
    links.delete(device)
    yield* close(subscription)
  })

  const presenceOf = (device: DeviceId): DevicePresence => {
    const link = links.get(device)
    return link === undefined
      ? DevicePresence.cases.Offline.make({})
      : DevicePresence.cases.Connected.make({ ability: link.ability })
  }

  /** A waiting computer's desktop app enrolled just now: it is open and asking to be allowed. */
  const knock = (device: DeviceId, at: number) => {
    knocks.set(device, at)
  }

  /**
   * Which of these computers are asking to be allowed at `now` (`DeviceListResponse.asking`):
   * still waiting, and enrolled within `DEVICE_ASKING_MILLIS`. A knock that has run out is
   * forgotten here, so the map holds only computers whose app was open in the last minute.
   */
  const askingOf = (list: ReadonlyArray<Device>, now: number): ReadonlyArray<DeviceId> =>
    list.flatMap((device) => {
      const at = knocks.get(device.id)
      if (at === undefined) return []
      if (now - at >= DEVICE_ASKING_MILLIS) {
        knocks.delete(device.id)
        return []
      }
      return DeviceAccess.guards.Pending(device.access) ? [device.id] : []
    })

  return { open, release, end, presenceOf, knock, askingOf }
}

type Presence = ReturnType<typeof makePresence>

/** The record of a Person's computers and who may be used: enrolling, listing, allowing, revoking. */
const makeRegistry = (database: DatabaseService, presence: Presence) => {
  const toDevice = Effect.fn('Device.toDevice')(function* (row: DeviceRow) {
    const stored = yield* decodeStoredDevice({
      id: row.id,
      name: row.name,
      access: { _tag: row.access, since: row.accessSince },
    })
    return Device.make({
      id: stored.id,
      name: stored.name,
      access: stored.access,
      presence: presence.presenceOf(stored.id),
    })
  })

  const owned = (personId: PersonId, id: DeviceId) =>
    and(eq(devices.id, id), eq(devices.personId, personId))

  const find = Effect.fn('Device.find')(function* (personId: PersonId, id: DeviceId) {
    const [row] = yield* database.run(database.select().from(devices).where(owned(personId, id)))
    // Another Person's computer and one that does not exist are the same answer on purpose.
    if (row === undefined) return yield* new NotFound({ message: 'Computer not found' })
    return row
  })

  /**
   * One installation is one Device for a Person. The insert does nothing when it already exists,
   * so a desktop app may enrol every time it starts; the access a Person already decided and a
   * name they may have changed are left alone.
   */
  const enrol = Effect.fn('Device.enrol')(function* (
    personId: PersonId,
    request: EnrolDeviceRequest,
  ) {
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .insert(devices)
        .values({
          id: DeviceId.make(NodeCrypto.randomUUID()),
          personId,
          installationId: request.installation,
          name: request.name,
          ...accessColumns(DeviceAccess.cases.Pending.make({ since: now })),
          enrolledAt: now,
        })
        .onConflictDoNothing({ target: [devices.personId, devices.installationId] }),
    )
    const [row] = yield* database.run(
      database
        .select()
        .from(devices)
        .where(
          and(eq(devices.personId, personId), eq(devices.installationId, request.installation)),
        ),
    )
    if (row === undefined)
      return yield* new DatabaseFailure({ message: 'Enrolled computer not found' })
    const device = yield* toDevice(row)
    if (DeviceAccess.guards.Pending(device.access)) presence.knock(device.id, now)
    return device
  })

  const list = Effect.fn('Device.list')(function* (personId: PersonId) {
    const rows = yield* database.run(
      database
        .select()
        .from(devices)
        .where(eq(devices.personId, personId))
        .orderBy(devices.enrolledAt, devices.id),
    )
    return yield* Effect.forEach(rows, toDevice)
  })

  /**
   * Allowing one computer revokes the Person's others in the same transaction, the reference's
   * connect-and-replace (artifacts/night/reviews/chatgpt-latest.md, section 4, "Attach/detach").
   * The Person's rows are locked first so two allows at once cannot both think they were last;
   * the partial unique index on the table refuses the result if they somehow did.
   */
  const allow = Effect.fn('Device.allow')(function* (personId: PersonId, id: DeviceId) {
    const now = yield* Clock.currentTimeMillis
    const replaced = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.personId, personId))
          .for('update')
        const [target] = yield* tx
          .select({ access: devices.access })
          .from(devices)
          .where(owned(personId, id))
        if (target === undefined) return yield* new NotFound({ message: 'Computer not found' })
        const others = yield* tx
          .update(devices)
          .set(accessColumns(DeviceAccess.cases.Revoked.make({ since: now })))
          .where(
            and(eq(devices.personId, personId), eq(devices.access, 'Allowed'), ne(devices.id, id)),
          )
          .returning({ id: devices.id })
        // Allowing what is already allowed keeps the moment it was first allowed.
        if (target.access !== 'Allowed')
          yield* tx
            .update(devices)
            .set(accessColumns(DeviceAccess.cases.Allowed.make({ since: now })))
            .where(owned(personId, id))
        return others
      }),
    )
    yield* Effect.forEach(replaced, (other) => presence.end(other.id), { discard: true })
    return yield* toDevice(yield* find(personId, id))
  })

  /** The write comes first and the link ends after it, so a link can never outlive its access. */
  const revoke = Effect.fn('Device.revoke')(function* (personId: PersonId, id: DeviceId) {
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .update(devices)
        .set(accessColumns(DeviceAccess.cases.Revoked.make({ since: now })))
        .where(and(owned(personId, id), ne(devices.access, 'Revoked'))),
    )
    const row = yield* find(personId, id)
    yield* presence.end(id)
    return yield* toDevice(row)
  })

  /** The computer Vivid may use for this Person right now: the allowed one, when it is listening. */
  const allowed = Effect.fn('Device.allowed')(function* (personId: PersonId) {
    const [row] = yield* database.run(
      database
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.personId, personId), eq(devices.access, 'Allowed'))),
    )
    return Option.fromUndefinedOr(row)
  })

  return { enrol, list, allow, revoke, allowed, find }
}

type Registry = ReturnType<typeof makeRegistry>

/**
 * Only the installation that enrolled a Device may listen for it, and only while it is allowed.
 * A browser tab or a phone signed in as the same Person can list and allow computers, but has no
 * installation to present, so it can never receive what is meant for the computer.
 */
const makeWatch = (database: DatabaseService, presence: Presence): DeviceService['watch'] => {
  const admit = Effect.fn('Device.admit')(function* (input: Parameters<DeviceService['watch']>[0]) {
    const [row] = yield* database.run(
      database
        .select({ access: devices.access })
        .from(devices)
        .where(
          and(
            eq(devices.id, input.device),
            eq(devices.personId, input.personId),
            eq(devices.installationId, input.installation),
          ),
        ),
    )
    if (row === undefined) return yield* new NotFound({ message: 'Computer not found' })
    if (row.access !== 'Allowed')
      return yield* new Forbidden({ message: 'This computer has not been allowed' })
    return undefined
  })

  return Effect.fn('Device.watch')(function* (input) {
    // Checked before the link opens, so a caller with no right to listen cannot displace the
    // computer that has one.
    yield* admit(input)
    const subscription = yield* Effect.acquireRelease(
      presence.open(input.device, input.sessionId, input.ability),
      presence.release,
    )
    // Checked again now that the link is registered: a revoke that committed in between has
    // either been seen here, or will find this link and end it.
    yield* admit(input)
    return Stream.fromQueue(subscription.requests).pipe(
      Stream.interruptWhen(Deferred.await(subscription.closed)),
    )
  })
}

/** The durable side of a dispatch: one row per request, moved once from `Dispatched` to its end. */
const makeLedger = (database: DatabaseService, pending: Map<DeviceRequestId, Pending>) => {
  const open = (id: DeviceRequestId) =>
    and(eq(deviceRequests.id, id), eq(deviceRequests.status, 'Dispatched'))

  /**
   * An answer is accepted only from the live link the request went out on, held by the session
   * that opened it, before the deadline, and once. The row is written before the waiting Run is
   * woken, and the two steps cannot be separated by the caller hanging up: a row that says
   * answered always has its answer delivered.
   */
  const answer = Effect.fn('Device.answer')(function* (
    personId: PersonId,
    sessionId: SessionId,
    input: AnswerDeviceRequest,
  ) {
    const ticket = pending.get(input.id)
    if (
      ticket === undefined ||
      ticket.subscription.device !== input.device ||
      ticket.subscription.sessionId !== sessionId ||
      (yield* Deferred.isDone(ticket.subscription.closed))
    )
      return yield* new Forbidden({ message: 'This request is no longer waiting for an answer' })
    const now = yield* Clock.currentTimeMillis
    const matches = DeviceWork.match(ticket.request.work, {
      Page: () => DeviceAnswer.isAnyOf(['Done', 'Refused', 'Failed'])(input.answer),
      Window: () => DeviceAnswer.isAnyOf(['Did', 'Declined', 'Failed'])(input.answer),
    })
    const receipt = matches ? receiptOf(input.answer) : DeviceReceipt.cases.OutcomeUnknown.make({})
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const written = yield* database.run(
          database
            .update(deviceRequests)
            .set({ receipt: yield* encodeReceipt(receipt) })
            .where(
              and(
                open(input.id),
                eq(deviceRequests.personId, personId),
                eq(deviceRequests.sessionId, sessionId),
                eq(deviceRequests.subscriptionId, ticket.subscription.id),
                gt(deviceRequests.expiresAt, now),
              ),
            )
            .returning({ id: deviceRequests.id }),
        )
        if (written.length !== 1)
          return yield* new Forbidden({
            message: 'This request has expired or was already answered',
          })
        if (DeviceReceipt.guards.Refused(receipt)) {
          // A committed answer decides Refused once; replays and outward Browse outcomes do not.
          yield* recordRefusal(Refusal.cases.DeviceRefused.make({ reason: receipt.reason }))
        }
        if (!matches)
          yield* Effect.logWarning('Device answer vocabulary did not match its work', {
            requestId: input.id,
          })
        // Stop revokes the Run and aborts the runtime before the waiting tool can continue.
        if (
          matches &&
          DeviceWork.guards.Window(ticket.request.work) &&
          DeviceAnswer.guards.Declined(input.answer) &&
          input.answer.reason === 'Stopped'
        )
          yield* stopPersonRun(personId, ticket.request.runId).pipe(
            Effect.provideService(Database, database),
            Effect.ensuring(Deferred.succeed(ticket.answer, input.answer)),
          )
        yield* Deferred.succeed(ticket.answer, input.answer)
        return undefined
      }),
    )
  })

  /**
   * Closes a request nobody answered in time, then reads the row once and reports what it says.
   * An answer can commit in the instant the deadline passes; when it has, the row is the truth
   * and the caller is given that answer, so the ledger and the Run never tell different stories.
   */
  const settle = Effect.fn('Device.settle')(function* (id: DeviceRequestId, ticket: Pending) {
    yield* database.run(
      database
        .update(deviceRequests)
        .set({ receipt: yield* encodeReceipt(DeviceReceipt.cases.OutcomeUnknown.make({})) })
        .where(open(id)),
    )
    const [row] = yield* database.run(
      database
        .select({ receipt: deviceRequests.receipt })
        .from(deviceRequests)
        .where(eq(deviceRequests.id, id)),
    )
    if (row === undefined)
      return yield* new DatabaseFailure({ message: 'Device request not found' })
    const receipt = yield* decodeReceipt(row.receipt)
    if (DeviceReceipt.isAnyOf(['Done', 'Refused', 'Did', 'Declined', 'Failed'])(receipt))
      return Option.some(yield* Deferred.await(ticket.answer))
    return Option.none<DeviceAnswer>()
  })

  /**
   * Requests whose deadline has passed and that still say `Dispatched` were abandoned: the server
   * stopped while they were waiting. No answer can be accepted for them any more, so saying
   * `OutcomeUnknown` is true whichever process sent them.
   */
  const reconcile = Effect.fn('Device.reconcile')(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .update(deviceRequests)
        .set({ receipt: yield* encodeReceipt(DeviceReceipt.cases.OutcomeUnknown.make({})) })
        .where(and(eq(deviceRequests.status, 'Dispatched'), lte(deviceRequests.expiresAt, now))),
    )
  })

  return { answer, settle, reconcile }
}

type Ledger = ReturnType<typeof makeLedger>

/**
 * Waits its turn on one computer, for a bounded time. The wait is the only part that may be cut
 * short here; once the turn is taken it is always given back, whatever happens to the work.
 */
const inTurn = <A, E>(turn: Semaphore.Semaphore, device: DeviceId, work: Effect.Effect<A, E>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const held = yield* Ref.make(false)
      // The race takes in a child. Record ownership under its mask before reporting success:
      // cancellation or timeout can win after the permit is taken but before the parent hears it.
      const take = Effect.uninterruptibleMask((allow) =>
        allow(turn.take(1)).pipe(Effect.andThen(Ref.set(held, true))),
      )
      return yield* Effect.gen(function* () {
        // Restore the entire race, including its deadline branch, so a queued Stop is prompt.
        const taken = yield* restore(take.pipe(Effect.timeoutOption(TURN_WAIT_MILLIS)))
        if (Option.isNone(taken)) return yield* new DeviceBusy({ device })
        return yield* restore(work)
      }).pipe(
        // This owns every exit, including losing the race after acquisition. Releasing only
        // around work would leak that permit and leave the Device permanently Busy.
        Effect.ensuring(
          Ref.get(held).pipe(Effect.flatMap((mine) => (mine ? turn.release(1) : Effect.void))),
        ),
      )
    }),
  )

interface Dispatch {
  readonly request: typeof DeviceRequest.cases.Act.Type
  readonly personId: PersonId
  readonly subscription: Subscription
}

/** Sends one request down a live link and waits for its answer, its deadline or the link's end. */
const makeSend = (
  database: DatabaseService,
  ledger: Ledger,
  pending: Map<DeviceRequestId, Pending>,
) => {
  /** Hands the request to the link, then waits for whichever comes first: answer, end, deadline. */
  const awaitAnswer = Effect.fn('Device.awaitAnswer')(function* (
    request: typeof DeviceRequest.cases.Act.Type,
    ticket: Pending,
  ) {
    const { subscription } = ticket
    // A link that ended while the row was being written is never sent to, and its replacement
    // is never handed a request it did not open with.
    if (!(yield* Deferred.isDone(subscription.closed))) {
      if (DeviceWork.guards.Window(request.work)) subscription.windowRuns.add(request.runId)
      yield* Queue.offer(subscription.requests, request)
    }
    const remaining = Math.max(0, request.expiresAt - (yield* Clock.currentTimeMillis))
    const answered = yield* Deferred.await(ticket.answer).pipe(
      Effect.asSome,
      Effect.raceFirst(
        Deferred.await(subscription.closed).pipe(Effect.as(Option.none<DeviceAnswer>())),
      ),
      Effect.timeoutOption(remaining),
    )
    return yield* Option.match(Option.flatten(answered), {
      onNone: () => ledger.settle(request.id, ticket),
      onSome: (answer) => Effect.succeedSome(answer),
    })
  })

  return Effect.fn('Device.send')(function* ({ request, personId, subscription }: Dispatch) {
    const ticket: Pending = { subscription, request, answer: yield* Deferred.make<DeviceAnswer>() }
    // The row is written before anything is sent: a request the computer saw always has a record.
    yield* database.run(
      database.insert(deviceRequests).values({
        id: request.id,
        deviceId: subscription.device,
        personId,
        sessionId: subscription.sessionId,
        subscriptionId: subscription.id,
        threadId: request.threadId,
        runId: request.runId,
        action: request.work.action._tag,
        receipt: yield* encodeReceipt(DeviceReceipt.cases.Dispatched.make({})),
        dispatchedAt: yield* Clock.currentTimeMillis,
        expiresAt: request.expiresAt,
      }),
    )
    pending.set(request.id, ticket)
    return yield* awaitAnswer(request, ticket).pipe(
      // Dispatch has a durable row and may already have reached the page. A failed settlement
      // write cannot turn uncertainty into a retryable refusal; reconcile will close the row.
      Effect.orElseSucceed(() => Option.none<DeviceAnswer>()),
      // A Run that is stopped mid-request has nobody left to tell. The row is still closed here;
      // if that write fails it stays `Dispatched` until its deadline, and `reconcile` closes it.
      Effect.onInterrupt(() =>
        ledger.settle(request.id, ticket).pipe(
          Effect.asVoid,
          Effect.catch((failure) =>
            Effect.logError('A stopped device request could not be closed', failure._tag),
          ),
        ),
      ),
      Effect.ensuring(Effect.sync(() => pending.delete(request.id))),
    )
  })
}

interface Dispatcher {
  readonly database: DatabaseService
  readonly registry: Registry
  readonly links: Map<DeviceId, Subscription>
  readonly send: ReturnType<typeof makeSend>
}

/**
 * Whether the Run named by a request may have its action sent, which depends on who is asking.
 *
 * `Acting`: the Run is sending its own action now, so it must still be working. `Approved`: the
 * Person answered an Approval the Run raised. Raising an Approval ends the Run's turn and the Run
 * settles as completed, so by the time anyone can press Allow the Run is never working. Requiring
 * a working Run there (as this did for a few hours on 4 October 2026) meant an approved action
 * was never sent: the card settled as failed, Vivid proposed again, and the Person was asked
 * again, for ever. An approved action is therefore sent for a Run that is working or completed.
 * A Run the Person stopped, or one that failed or whose outcome is unknown, authorizes nothing
 * either way: stopping is the Person saying "no more from this".
 */
const dispatchRun = Effect.fn('Device.dispatchRun')(function* (input: {
  personId: PersonId
  threadId: ThreadId
  runId: RunId
  authority: BrowseAuthority
}) {
  const state = yield* admittedRunState(input)
  return RunState.match(state, {
    Working: () => true,
    Completed: () => BrowseAuthority.guards.Approved(input.authority),
    Failed: () => false,
    Stopped: () => false,
    Unknown: () => false,
  })
})

/**
 * The whole path of one action: which Run is asking, which computer it may use, its turn, the
 * request itself.
 *
 * Each Device has its own turn, so one Person's slow computer never delays another Person's. The
 * deadline is fixed before the turn is waited for: time spent queueing is time the request no
 * longer has.
 */
const makeDispatch = ({ database, registry, links, send }: Dispatcher) => {
  const turns = new Map<DeviceId, Semaphore.Semaphore>()
  const turnOf = (device: DeviceId) => {
    const existing = turns.get(device)
    if (existing !== undefined) return existing
    const created = Semaphore.makeUnsafe(1)
    turns.set(device, created)
    return created
  }

  return Effect.fn('Device.dispatch')(function* (input: {
    personId: PersonId
    threadId: ThreadId
    runId: RunId
    work: DeviceWork
    authority: BrowseAuthority
  }) {
    if (!(yield* dispatchRun(input).pipe(Effect.provideService(Database, database))))
      return yield* new RunNotWorking({ runId: input.runId })
    const device = yield* registry.allowed(input.personId)
    if (Option.isNone(device)) return yield* new NoDeviceConnected({})
    const id = device.value.id
    if (DeviceWork.guards.Window(input.work)) {
      const link = links.get(id)
      if (link === undefined) return yield* new NoDeviceConnected({})
      if (!link.ability.apps) return yield* new WindowUnavailable({})
    }
    const expiresAt = (yield* Clock.currentTimeMillis) + REQUEST_BUDGET_MILLIS
    return yield* inTurn(
      turnOf(id),
      id,
      Effect.gen(function* () {
        // Stop can arrive while queued; recheck the same Run immediately before dispatch.
        if (!(yield* dispatchRun(input).pipe(Effect.provideService(Database, database))))
          return yield* new RunNotWorking({ runId: input.runId })
        const allowed = yield* registry.allowed(input.personId)
        if (Option.isNone(allowed) || allowed.value.id !== id)
          return yield* new NoDeviceConnected({})
        // Read after the turn is taken: the link that was there when the wait began may be gone.
        const subscription = links.get(id)
        if (subscription === undefined) return yield* new NoDeviceConnected({})
        const request = DeviceRequest.cases.Act.make({
          id: DeviceRequestId.make(NodeCrypto.randomUUID()),
          threadId: input.threadId,
          runId: input.runId,
          work: input.work,
          expiresAt,
        })
        if (DeviceWork.guards.Window(input.work) && !subscription.ability.apps)
          return yield* new WindowUnavailable({})
        return yield* send({ request, personId: input.personId, subscription })
      }),
    )
  })
}

/** Native outcomes share transport with pages while retaining their distinct protocol vocabulary. */
const windowOutcome = (answer: DeviceAnswer): WindowOutcome =>
  DeviceAnswer.match<WindowOutcome>(answer, {
    Did: ({ result }) => WindowOutcome.cases.Completed.make({ result }),
    Declined: ({ reason }) => WindowOutcome.cases.Refused.make({ reason }),
    Done: () => WindowOutcome.cases.OutcomeUnknown.make({}),
    Refused: () => WindowOutcome.cases.OutcomeUnknown.make({}),
    Failed: () =>
      WindowOutcome.cases.Unavailable.make({
        reason: 'The Person’s computer could not complete this action.',
      }),
  })

/** A connected Device without its Windows helper cannot accept window work. */
class WindowUnavailable extends Schema.TaggedError<WindowUnavailable>()(
  'WindowUnavailable',
  {},
  { title: 'Windows apps are unavailable' },
) {}

const windowsUnavailable = () =>
  WindowOutcome.cases.Unavailable.make({
    reason: 'The Windows helper is not running on this computer.',
  })

/** Native admission and lifecycle use the existing page link, semaphore, ledger and deadline. */
const makeWindows = ({
  links,
  dispatch,
}: {
  links: Map<DeviceId, Subscription>
  dispatch: ReturnType<typeof makeDispatch>
}) => {
  /** Only links offered Window work receive this signal. Deleting before offering makes it once;
   * disconnect discards the link and its Runs, so an offline Device simply misses the signal. */
  const ended = Effect.fn('Device.runEnded')(function* (runId: RunId) {
    yield* Effect.forEach(
      links.values(),
      Effect.fn('Device.endTurn')(function* (link) {
        if (link.windowRuns.delete(runId) && !(yield* Deferred.isDone(link.closed)))
          yield* Queue.offer(link.requests, DeviceRequest.cases.RunEnded.make({ runId }))
      }),
      { discard: true },
    )
  })

  /** No Gate, Approval or app rules: it is the Person's own machine and they allowed it.
   * Acting authority requires their Working Run both before queueing and before sending. */
  const window = Effect.fn('Device.window')(function* (
    input: Parameters<DeviceService['window']>[0],
  ) {
    return yield* dispatch({
      ...input,
      work: DeviceWork.cases.Window.make({ action: input.action }),
      authority: BrowseAuthority.cases.Acting.make({}),
    }).pipe(
      Effect.map((answer) =>
        Option.match(answer, {
          onNone: () => WindowOutcome.cases.OutcomeUnknown.make({}),
          onSome: windowOutcome,
        }),
      ),
      Effect.catchTags({
        NoDeviceConnected: () => Effect.succeed(WindowOutcome.cases.NotConnected.make({})),
        NoActingRun: () => Effect.succeed(WindowOutcome.cases.RunRequired.make({})),
        RunNotWorking: () => Effect.succeed(WindowOutcome.cases.RunRequired.make({})),
        DeviceBusy: () => Effect.succeed(WindowOutcome.cases.Busy.make({})),
        WindowUnavailable: () => Effect.succeed(windowsUnavailable()),
      }),
    )
  })
  return { window, ended }
}

/**
 * The database does not have the tables this code was written for: product migrations have not
 * been applied to it. `missing` names what was looked for and not found.
 */
export class ProductMigrationsBehind extends Schema.TaggedError<ProductMigrationsBehind>()(
  'ProductMigrationsBehind',
  { missing: Schema.Literals(['vivid_devices', 'vivid_device_requests.receipt']) },
  { title: 'Product migrations have not been applied to this database' },
) {}

const decodeCatalog = decodeStored(
  Schema.Struct({
    rows: Schema.Tuple([Schema.Struct({ devices: Schema.Boolean, receipt: Schema.Boolean })]),
  }),
  'device catalog answer',
)

/**
 * Asks PostgreSQL's catalog whether the Device tables are the ones this code writes to, before the
 * first write. A server started against a database that is a migration behind would otherwise
 * stop with nothing but "Database operation failed", because the driver's reason is deliberately
 * not carried past the database adapter.
 *
 * Launch fails on this, with this error, rather than running without Devices. A schema behind its
 * code is wrong for every domain at once, so a server that came up anyway would only move the
 * same failure to a Person's first call; and a Device service that might not be there would have
 * to be modelled as absent everywhere it is used, for a state that is a deployment mistake.
 */
const requireLedger = Effect.fn('Device.requireLedger')(function* (database: DatabaseService) {
  const catalog = yield* decodeCatalog(
    yield* database.run(
      database.execute(sql`
        SELECT to_regclass('public.vivid_devices') IS NOT NULL AS devices,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'vivid_device_requests'
              AND column_name = 'receipt'
          ) AS receipt
      `),
    ),
  )
  const [found] = catalog.rows
  if (!found.devices) return yield* behind('vivid_devices')
  if (!found.receipt) return yield* behind('vivid_device_requests.receipt')
  return undefined
})

/** Says it in the log as well as in the failure: launch output is where an operator looks first. */
const behind = Effect.fn('Device.behind')(function* (missing: ProductMigrationsBehind['missing']) {
  yield* Effect.logError(
    `Product migrations are behind this server: ${missing} is missing. Apply them with \`pnpm db:migrate\` and start again.`,
  )
  return yield* new ProductMigrationsBehind({ missing })
})

/** Single-replica authority: these maps hold presence and the sockets browse requests route to. */
export const deviceLayer = Layer.effect(
  DeviceRegistry,
  Effect.gen(function* () {
    const database = yield* Database
    const links = new Map<DeviceId, Subscription>()
    const pending = new Map<DeviceRequestId, Pending>()
    const presence = makePresence(links, new Map())
    const registry = makeRegistry(database, presence)
    const ledger = makeLedger(database, pending)

    // The first thing this service does is write to its ledger, so it is also the first thing
    // to meet a database whose migrations are behind. That is said by name before anything runs.
    yield* requireLedger(database)
    // Once now, for what a previous process left behind and whose deadline has passed; once more
    // when every deadline that process could have issued has passed too.
    yield* ledger.reconcile()
    yield* Effect.sleep(REQUEST_BUDGET_MILLIS).pipe(
      Effect.andThen(ledger.reconcile()),
      Effect.catch((failure) =>
        Effect.logError('Abandoned device requests could not be closed', failure._tag),
      ),
      Effect.forkScoped,
    )

    const dispatch = makeDispatch({
      database,
      registry,
      links,
      send: makeSend(database, ledger, pending),
    })
    const windows = makeWindows({ links, dispatch })

    const requireConnected = Effect.fn('Device.requireConnected')(function* (personId: PersonId) {
      const device = yield* registry.allowed(personId)
      if (Option.isNone(device) || !links.has(device.value.id))
        return yield* new NoDeviceConnected({})
      return undefined
    })

    return DeviceRegistry.of({
      enrol: registry.enrol,
      list: registry.list,
      asking: Effect.fn('Device.asking')(function* (list) {
        return presence.askingOf(list, yield* Clock.currentTimeMillis)
      }),
      allow: registry.allow,
      revoke: registry.revoke,
      requireConnected,
      watch: makeWatch(database, presence),
      ...windows,
      reportStop: Effect.fn('Device.reportStop')(function* (personId, input) {
        const row = yield* registry.find(personId, input.device)
        if (row.installationId !== input.installation)
          return yield* new Forbidden({ message: 'This installation does not own this computer' })
        yield* stopPersonRun(personId, input.runId).pipe(Effect.provideService(Database, database))
        yield* windows.ended(input.runId)
        return undefined
      }),
      answer: Effect.fn('Device.acceptAnswer')(function* (personId, sessionId, input) {
        const ticket = pending.get(input.id)
        yield* ledger.answer(personId, sessionId, input)
        if (
          ticket !== undefined &&
          DeviceWork.guards.Window(ticket.request.work) &&
          DeviceAnswer.guards.Declined(input.answer) &&
          input.answer.reason === 'Stopped'
        ) {
          yield* windows.ended(ticket.request.runId)
        }
      }),
      browse: Effect.fn('Device.browse')(
        function* (input) {
          const answer = yield* dispatch({
            personId: input.personId,
            threadId: input.threadId,
            runId: input.runId,
            work: DeviceWork.cases.Page.make({ action: input.action }),
            authority: input.authority,
          }).pipe(
            Effect.catchTag('WindowUnavailable', () =>
              Effect.succeedSome(DeviceAnswer.cases.Failed.make({})),
            ),
          )
          return Option.match(answer, {
            onNone: () => BrowseOutcome.cases.OutcomeUnknown.make({}),
            onSome: outcomeOf,
          })
        },
        (effect) =>
          effect.pipe(
            Effect.catchTag('RunNotWorking', () =>
              Effect.succeed(BrowseOutcome.cases.RunRequired.make({})),
            ),
          ),
      ),
    })
  }),
)
