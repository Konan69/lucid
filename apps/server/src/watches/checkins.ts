import * as NodeCrypto from 'node:crypto'
import { Effect, Option, Schema } from 'effect'
import {
  CheckinArming,
  CheckinFocus,
  AvailableCheckinFocus,
  CheckinTiming,
  CheckinNotFound,
  CheckinNotScheduled,
  OpenWork,
  OwedState,
  TimerOperationKey,
  TimerReceipt,
  WatchPurpose,
  WatchIntent,
  Watch,
  NotFound,
  type ConnectionId,
  type Owed,
  type UpdateCheckinRequest,
} from '@vivid/contracts'
import { companyColumnOf, findPerson, type Actor } from '../auth/access.ts'
import { workspaceIn } from '../auth/session.ts'
import { Database } from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { OwedStore } from '../owed/store.ts'
import { requireThread } from '../threads/access.ts'
import { ExecutorEvents } from './events.ts'
import { WatchStore, type WatchRecord } from './store.ts'

/** One new intent gets one durable key; timer retries read and reuse it. */
export const awaiting = () =>
  CheckinArming.cases.Awaiting.make({
    operationKey: TimerOperationKey.make(NodeCrypto.randomUUID()),
  })

/** Match explicit record identity; a Thread is open only because one of these records names it. */
const matches = (focus: CheckinFocus, work: OpenWork) =>
  CheckinFocus.match(focus, {
    OpenWork: () => true,
    Owed: ({ owedId }) => OpenWork.guards.Owed(work) && work.owedId === owedId,
    Thread: ({ threadId }) => work.threadId === threadId,
    Project: ({ projectId }) => OpenWork.guards.Project(work) && work.projectId === projectId,
  })

/** Source closure evidence is the persisted resolution or drop reason, not event text. */
const ending = (record: Owed) =>
  OwedState.match(record.state, {
    Open: () => Option.none<string>(),
    Nudged: () => Option.none<string>(),
    Resolved: ({ how }) => Option.some(how),
    Dropped: ({ why }) => Option.some(why),
  })
const operation = Schema.decodeUnknownOption(Schema.Struct({ operationKey: TimerOperationKey }))
const receipt = Schema.decodeUnknownOption(TimerReceipt)

/** Project each owned obligation with the Watches that cover it. */
const sourceOf = (record: Owed, watches: ReadonlyArray<WatchRecord>) => {
  const source = OpenWork.cases.Owed.make({
    owedId: record.id,
    threadId: record.threadId,
    what: record.what,
    from: record.from,
    nextStep: record.nextStep,
    due: record.due,
    checkins: [],
  })
  const checkins = watches.flatMap(({ watch }) =>
    WatchPurpose.guards.Checkin(watch.purpose) && matches(watch.purpose.focus, source)
      ? [watch.name]
      : [],
  )
  return OpenWork.cases.Owed.make({ ...source, checkins })
}

/** A source read either scopes this check or proves that it has ended. */
export const CheckinRead = Schema.TaggedUnion({
  Open: { context: Schema.NonEmptyString },
  Closed: { evidence: Schema.NonEmptyString },
})
export type CheckinRead = typeof CheckinRead.Type

/** Only names and product facts enter model context; source identifiers remain server metadata. */
const sourceContext = (records: ReadonlyArray<Owed>) =>
  JSON.stringify(records.map(({ what, from, nextStep, due }) => ({ what, from, nextStep, due })))

/** Requested sweeps retain their timer even if the inventory is temporarily empty. */
const sweepRead = (records: ReadonlyArray<Owed>, timing: CheckinTiming) => {
  const open = records.filter((item) => OwedState.isAnyOf(['Open', 'Nudged'])(item.state))
  if (open.length === 0 && CheckinTiming.guards.Chosen(timing))
    return CheckinRead.cases.Closed.make({ evidence: sourceContext(open) })
  return CheckinRead.cases.Open.make({ context: sourceContext(open) })
}

/** Re-read the source at firing. An explicitly requested OpenWork sweep keeps its recurrence. */
const sourceReading = Effect.fn('Checkins.closed')(function* (record: WatchRecord) {
  const owed = yield* OwedStore
  const database = yield* Database
  if (!WatchPurpose.guards.Checkin(record.watch.purpose)) return Option.none<CheckinRead>()
  const purpose = record.watch.purpose
  const person = yield* findPerson(record.personId).pipe(Effect.provideService(Database, database))
  if (Option.isNone(person)) return yield* new NotFound({ message: 'Person not found' })
  const workspace = yield* workspaceIn(record.personId, Option.fromNullOr(record.companyId)).pipe(
    Effect.provideService(Database, database),
  )
  if (companyColumnOf(workspace) !== record.companyId)
    return yield* new NotFound({ message: 'Thread not found' })
  const actor: Actor = { person: person.value, workspace, by: 'vivid', threadId: Option.none() }
  const records = yield* owed.list(actor)
  const read = AvailableCheckinFocus.match(purpose.focus, {
    Owed: ({ owedId }) => {
      const source = records.find((item) => item.id === owedId)
      if (source === undefined)
        return CheckinRead.cases.Closed.make({ evidence: JSON.stringify({ found: false }) })
      return Option.match(ending(source), {
        onNone: () => CheckinRead.cases.Open.make({ context: sourceContext([source]) }),
        onSome: (evidence) => CheckinRead.cases.Closed.make({ evidence }),
      })
    },
    OpenWork: () => sweepRead(records, purpose.timing),
    Thread: ({ threadId }) =>
      sweepRead(
        records.filter((item) => item.threadId === threadId),
        purpose.timing,
      ),
  })
  return Option.some(read)
})

/** Observe the actual provider result, scoped to the timer Connection, owner and persisted key. */
const timerConfirmation = Effect.fn('Checkins.confirm')(function* (
  actor: Actor,
  connectionId: ConnectionId,
  input: Schema.Json,
  output: Schema.Json,
) {
  const store = yield* WatchStore
  const changes = yield* Changes
  const key = operation(input)
  if (Option.isNone(key)) return
  const watches = yield* store.list(actor)
  const found = watches.find(
    (record) =>
      record.connectionId === connectionId &&
      WatchPurpose.guards.Checkin(record.watch.purpose) &&
      record.watch.purpose.arming.operationKey === key.value.operationKey,
  )
  if (found === undefined || !WatchPurpose.guards.Checkin(found.watch.purpose)) return
  const planned = found.watch.purpose
  const read = receipt(output)
  if (
    Option.isNone(read) ||
    read.value.operationKey !== key.value.operationKey ||
    (CheckinTiming.guards.Chosen(planned.timing) && planned.timing.nextAt !== read.value.nextAt)
  )
    return yield* new CheckinNotScheduled({
      watchId: found.watch.id,
      operationKey: key.value.operationKey,
      message: 'The check-in was not scheduled; nothing will wake Vivid for it yet.',
    })
  const purpose = WatchPurpose.cases.Checkin.make({
    focus: planned.focus,
    timing: planned.timing,
    arming: CheckinArming.cases.Confirmed.make(read.value),
  })
  const confirmed = yield* store.purpose(
    found.watch.id,
    purpose,
    Option.some(key.value.operationKey),
  )
  if (Option.isSome(confirmed)) yield* changes.publish([Topic.person(confirmed.value.personId)])
})

/** Check-in intent and receipt handling share the Watch store; the Integration owns every timer. */
export const watchCheckins = Effect.fn('Watches.checkins')(function* () {
  const store = yield* WatchStore
  const owed = yield* OwedStore
  const database = yield* Database
  const changes = yield* Changes
  const events = yield* ExecutorEvents
  const publish = (record: WatchRecord) => changes.publish([Topic.person(record.personId)])

  /** Return only explicit open obligations, with existing check-ins so the model does not duplicate them. */
  const list = Effect.fn('Checkins.list')(function* (actor: Actor) {
    const watches = yield* store.list(actor)
    const records = (yield* owed.list(actor)).filter((record) =>
      OwedState.isAnyOf(['Open', 'Nudged'])(record.state),
    )
    return records.map((record) => sourceOf(record, watches))
  })

  /** Validate ownership before persisting a source identity supplied over RPC. */
  const validate = Effect.fn('Checkins.validate')(function* (
    actor: Actor,
    focus: typeof WatchPurpose.cases.Checkin.Type.focus,
  ) {
    if (
      CheckinFocus.guards.Owed(focus) &&
      !(yield* owed.list(actor)).some((record) => record.id === focus.owedId)
    )
      return yield* new NotFound({ message: 'Owed record not found' })
    if (CheckinFocus.guards.Thread(focus))
      yield* requireThread(focus.threadId, actor.person.id).pipe(
        Effect.provideService(Database, database),
      )
  })

  /** Validate a new intent before assigning its server-owned operation key. */
  const plan = Effect.fn('Checkins.plan')(function* (actor: Actor, intent: WatchIntent) {
    if (WatchIntent.guards.Checkin(intent)) yield* validate(actor, intent.focus)
    return WatchIntent.match<WatchPurpose>(intent, {
      Event: () => WatchPurpose.cases.Event.make({}),
      Checkin: ({ focus, timing }) =>
        WatchPurpose.cases.Checkin.make({ focus, timing, arming: awaiting() }),
    })
  })

  /** Reset arming before dispatch. A superseded receipt cannot restore the old intent. */
  const update = Effect.fn('Checkins.update')(function* (
    actor: Actor,
    request: UpdateCheckinRequest,
  ) {
    const missing = () =>
      new CheckinNotFound({
        personId: actor.person.id,
        name: request.name,
        message: 'There is no check-in by that name.',
      })
    const found = yield* store.named(actor, request.name)
    if (Option.isNone(found) || !WatchPurpose.guards.Checkin(found.value.watch.purpose))
      return yield* missing()
    yield* validate(actor, request.focus)
    const purpose = WatchPurpose.cases.Checkin.make({
      focus: request.focus,
      timing: request.timing,
      arming: awaiting(),
    })
    const changed = yield* store.purpose(found.value.watch.id, purpose, Option.none())
    if (Option.isNone(changed)) return yield* missing()
    yield* publish(changed.value)
    return Watch.make({ ...changed.value.watch, account: found.value.watch.account })
  })

  /** Local completion wins before best-effort provider cleanup, just as explicit Watch completion does. */
  const finish = Effect.fn('Checkins.finish')(function* (
    record: WatchRecord,
    runId: import('@vivid/contracts').RunId,
    evidence: string,
  ) {
    if (!WatchPurpose.guards.Checkin(record.watch.purpose)) return
    const completed = yield* store.completeCheckin({
      id: record.watch.id,
      operationKey: record.watch.purpose.arming.operationKey,
      runId,
      evidence,
    })
    if (Option.isNone(completed)) return
    yield* publish(completed.value)
    yield* events
      .unsubscribe({
        name: record.subscribedName,
        arguments: record.watch.arguments,
        url: record.callbackUrl,
      })
      .pipe(Effect.ignore)
  })
  return {
    planCheckin: plan,
    listOpenWork: list,
    updateCheckin: update,
    confirmTimer: (
      actor: Actor,
      connectionId: ConnectionId,
      input: Schema.Json,
      output: Schema.Json,
    ) =>
      timerConfirmation(actor, connectionId, input, output).pipe(
        Effect.provideService(WatchStore, store),
        Effect.provideService(Changes, changes),
      ),
    readCheckin: (record: WatchRecord) =>
      sourceReading(record).pipe(
        Effect.provideService(Database, database),
        Effect.provideService(OwedStore, owed),
      ),
    finishCheckin: finish,
  }
})
