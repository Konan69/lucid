import { and, eq, isNull, or, sql } from 'drizzle-orm'
import {
  ApprovalInvalidation,
  ConnectionId,
  DatabaseFailure,
  WatchArguments,
} from '@vivid/contracts'
import { Cause, Clock, Duration, Effect, Layer, Option, Result, Schedule, Schema } from 'effect'
import { Database, decodeStored } from '../database/client.ts'
import { ServerConfig } from '../config.ts'
import { invalidatePending, usingConnection } from '../approvals/stale.ts'
import { ExecutorEvents } from '../watches/events.ts'
import { disconnectWatches } from '../watches/apps.ts'
import { secretFor } from '../watches/signature.ts'
import { watches } from '../watches/tables.ts'
import { ExecutorAdoption } from './adopter.ts'
import { AdoptionSourceUnsupported, adoptionFiles, adoptedFiles } from './adoption.ts'
import {
  AdoptedSource,
  Executor,
  ExecutorAppOwnership,
  ExecutorBinding,
  ExecutorReferences,
  installationCaller,
  type ExecutorCaller,
} from './executor.ts'
import { ExecutorMembers, MemberState } from './members.ts'
import { decodeRow, encodeReferences, type ConnectionRecord } from './records.ts'
import { connections, executorMembers } from './tables.ts'

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]
const sourceUnsupported = Schema.is(AdoptionSourceUnsupported)
const decodeArguments = decodeStored(WatchArguments, 'Watch adoption arguments')
const decodeClaim = decodeStored(
  Schema.Struct({ rows: Schema.Tuple([Schema.Struct({ acquired: Schema.Boolean })]) }),
  'Connection adoption claim',
)
const decodeMember = decodeStored(MemberState, 'Executor member')
const Outcome = Schema.TaggedUnion({
  Moved: {},
  Finalized: {},
  Busy: {},
  Gone: {},
  Deferred: {
    reason: Schema.Literals([
      'Shared',
      'Unproven',
      'PendingAuthorization',
      'RetiredResources',
      'AccountEvents',
      'Binding',
    ]),
  },
})
type Outcome = typeof Outcome.Type

/** Existing Connection rows are the durable work, not a new queue. A Workflow/Activity would
 * add another source of progress without joining these guarded row writes. The references mark
 * the crash boundary before HTTP; a per-row transaction lock serializes writers, while MVCC
 * reads continue on the last committed reference. No reads await this scoped boot worker. */
const claim = Effect.fn('Connections.claimAdoption')(function* <E, R>(
  id: ConnectionId,
  step: (row: ConnectionRecord, tx: Transaction) => Effect.Effect<Outcome, E, R>,
) {
  const database = yield* Database
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const claimed = yield* tx.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`vivid-adopt:${id}`}, 0)) as acquired`,
      )
      const [lock] = (yield* decodeClaim(claimed)).rows
      if (!lock.acquired) return Outcome.cases.Busy.make({})
      const [raw] = yield* tx.select().from(connections).where(eq(connections.id, id)).for('update')
      if (raw === undefined) return Outcome.cases.Gone.make({})
      return yield* step(yield* decodeRow(raw), tx)
    }),
  )
})

/** Provisioning is independently durable in ExecutorMembers. Only its Ready user names a group. */
const memberFor = Effect.fn('Connections.adoptionMember')(function* (row: ConnectionRecord) {
  const caller = yield* (yield* ExecutorMembers).caller({
    principal: 'member',
    personId: row.personId,
  })
  const database = yield* Database
  const [stored] = yield* database.run(
    database.select().from(executorMembers).where(eq(executorMembers.personId, row.personId)),
  )
  if (stored === undefined)
    return yield* new DatabaseFailure({ message: 'Executor member is missing after provisioning' })
  const state = yield* decodeMember(stored.state)
  if (!MemberState.guards.Ready(state))
    return yield* new DatabaseFailure({
      message: 'Executor member is not ready after provisioning',
    })
  return { caller, user: state.user }
})

/** The bridge marker commits before any source or link changes. A refused source stays entirely
 * Installation-owned. Pending browser grants still target the original user and cannot simply
 * be relabelled Member: preserve them until completion, then adopt their saved account. */
const prepare = Effect.fn('Connections.prepareAdoption')(function* (
  row: ConnectionRecord,
  tx: Transaction,
) {
  if (
    row.executorPrincipal !== 'installation' ||
    ExecutorReferences.guards.Adopting(row.references)
  )
    return Outcome.cases.Gone.make({})
  if (row.companyId !== null) return Outcome.cases.Deferred.make({ reason: 'Shared' })
  const references = row.references
  if (ExecutorReferences.guards.ReconnectRequired(references)) {
    if (Option.isSome(references.retired.account))
      return Outcome.cases.Deferred.make({ reason: 'RetiredResources' })
    yield* tx
      .update(connections)
      .set({ executorPrincipal: 'member' })
      .where(eq(connections.id, row.id))
    return Outcome.cases.Moved.make({})
  }
  if (!ExecutorReferences.isAnyOf(['Public', 'Authorized'])(references))
    return Outcome.cases.Deferred.make({ reason: 'PendingAuthorization' })
  if (!ExecutorAppOwnership.guards.Dedicated(references.appOwnership))
    return Outcome.cases.Deferred.make({ reason: 'Unproven' })
  if (ExecutorReferences.guards.Public(references)) return Outcome.cases.Gone.make({})
  const binding = references.binding
  if (!ExecutorBinding.guards.Account(binding) || binding.scope !== 'user')
    return Outcome.cases.Deferred.make({ reason: 'Binding' })
  // beta.23 event delivery requires direct account access, even for app-linked personal accounts.
  if ((yield* disconnectWatches(tx, row.id)).length > 0)
    return Outcome.cases.Deferred.make({ reason: 'AccountEvents' })
  const adopter = yield* ExecutorAdoption
  const source = yield* adopter.source(references.app)
  yield* adoptionFiles(source, binding.requirement, 'vividAdopted')
  const member = yield* memberFor(row)
  const group = yield* adopter.group(`vivid-adopt-${row.id}`, member.user, true)
  const adopting = ExecutorReferences.cases.Adopting.make({
    service: references.service,
    app: references.app,
    owner: references.owner,
    binding,
    appOwnership: references.appOwnership,
    account: references.account,
    original: binding.requirement,
    adopted: 'vividAdopted',
    group: group.id,
  })
  yield* tx
    .update(connections)
    .set({
      references: yield* encodeReferences(adopting),
      updatedAt: Math.max(yield* Clock.currentTimeMillis, row.updatedAt + 1),
    })
    .where(eq(connections.id, row.id))
  return Outcome.cases.Moved.make({})
})

/** Subscribe with the member before committing the principal. The staged audience still lets
 * the old owner deliver, so an interrupted handover keeps a working subscription. Repeated
 * subscribe reuses Executor's deterministic key; the receiver deduplicates overlapping deliveries. */
const handover = Effect.fn('Connections.handoverWatches')(function* (
  tx: Transaction,
  row: ConnectionRecord,
  caller: ExecutorCaller,
) {
  const events = yield* ExecutorEvents
  const config = yield* ServerConfig
  const records = yield* tx.select().from(watches).where(eq(watches.connectionId, row.id))
  for (const watch of records) {
    if (watch.state !== 'Active' && watch.state !== 'Pending') continue
    yield* events.subscribe(caller, {
      name: watch.subscribedName,
      arguments: yield* decodeArguments(watch.arguments),
      url: watch.callbackUrl,
      secret: secretFor(config.AUTH_SECRET, watch.id),
      ttlMs: 7 * 24 * 60 * 60_000,
    })
  }
})

/** All steps before this row commit leave the original user requirement and the owner usable. */
const move = Effect.fn('Connections.moveAdoption')(function* (
  row: ConnectionRecord,
  tx: Transaction,
) {
  if (row.executorPrincipal !== 'installation') return Outcome.cases.Gone.make({})
  const references = row.references
  if (!ExecutorReferences.isAnyOf(['Public', 'Adopting'])(references) || row.companyId !== null)
    return Outcome.cases.Gone.make({})
  if (
    ExecutorReferences.guards.Adopting(references) &&
    (yield* disconnectWatches(tx, row.id)).length > 0
  )
    return Outcome.cases.Deferred.make({ reason: 'AccountEvents' })
  const member = yield* memberFor(row)
  const adopter = yield* ExecutorAdoption
  const executor = yield* Executor
  const group = yield* adopter.group(`vivid-adopt-${row.id}`, member.user, true)
  let source: typeof AdoptedSource.Type = AdoptedSource.cases.Public.make({})
  if (ExecutorReferences.guards.Adopting(references)) {
    const files = yield* adopter.source(references.app)
    const bridge = yield* adoptionFiles(files, references.original, references.adopted)
    if (bridge !== files) yield* adopter.deploy(references.app, bridge)
    yield* executor.as(installationCaller).refresh
    yield* adopter.link(references.app, references.adopted, references.account)
    source = AdoptedSource.cases.Account.make({
      original: references.original,
      adopted: references.adopted,
      account: references.account,
    })
  }
  yield* adopter.audience(references.app, group.id)
  const appOwnership = ExecutorAppOwnership.cases.Adopted.make({ group: group.id, source })
  const adopted = ExecutorReferences.guards.Adopting(references)
    ? ExecutorReferences.cases.Authorized.make({
        service: references.service,
        app: references.app,
        owner: references.owner,
        account: references.account,
        appOwnership,
        binding: ExecutorBinding.cases.Account.make({
          scope: 'app',
          requirement: references.adopted,
        }),
      })
    : ExecutorReferences.cases.Public.make({
        service: references.service,
        app: references.app,
        owner: references.owner,
        binding: references.binding,
        appOwnership,
      })
  yield* executor.as(member.caller).refresh
  yield* executor.as(member.caller).tools(adopted)
  yield* handover(tx, row, member.caller)
  const [saved] = yield* tx
    .update(connections)
    .set({
      references: yield* encodeReferences(adopted),
      executorPrincipal: 'adopted',
      authorizationGeneration: sql`${connections.authorizationGeneration} + 1`,
      updatedAt: yield* Clock.currentTimeMillis,
    })
    .where(eq(connections.id, row.id))
    .returning({ generation: connections.authorizationGeneration })
  if (saved === undefined)
    return yield* new DatabaseFailure({ message: 'Adopted Connection was not returned' })
  yield* invalidatePending(
    tx,
    usingConnection(row.id),
    ApprovalInvalidation.cases.ConnectionChanged.make({
      connectionId: row.id,
      generation: saved.generation,
    }),
  )
  return Outcome.cases.Moved.make({})
})

/** This post-commit step runs for every Adopted row, even after a crash. Source retirement and
 * subscription removal precede owner removal. A failure leaves the member working and retries
 * the same exact resources, never reinstalling an app or discarding its stored data. */
const finalize = Effect.fn('Connections.finalizeAdoption')(function* (
  row: ConnectionRecord,
  tx: Transaction,
) {
  if (
    row.executorPrincipal !== 'adopted' ||
    !ExecutorReferences.isAnyOf(['Public', 'Authorized'])(row.references)
  )
    return Outcome.cases.Gone.make({})
  const references = row.references
  const ownership = references.appOwnership
  if (!ExecutorAppOwnership.guards.Adopted(ownership))
    return Outcome.cases.Deferred.make({ reason: 'Unproven' })
  const adopter = yield* ExecutorAdoption
  const member = yield* memberFor(row)
  if (AdoptedSource.guards.Account(ownership.source)) {
    const source = yield* adopter.source(references.app)
    const files = yield* adoptedFiles(source, ownership.source.original, ownership.source.adopted)
    if (files !== source) yield* adopter.deploy(references.app, files)
    yield* (yield* Executor).as(member.caller).refresh
  }
  const events = yield* ExecutorEvents
  for (const watch of yield* tx.select().from(watches).where(eq(watches.connectionId, row.id)))
    yield* events.unsubscribe(installationCaller, {
      name: watch.subscribedName,
      arguments: yield* decodeArguments(watch.arguments),
      url: watch.callbackUrl,
    })
  yield* adopter.group(`vivid-adopt-${row.id}`, member.user, false)
  return Outcome.cases.Finalized.make({})
})

/** Probe the public beta.23 group contract before row writes. Each row has its own claim and
 * typed result, so one unsupported app cannot block other Persons' Connections or their reads. */
export const adoptConnections = Effect.fn('Connections.adopt')(function* () {
  const adopter = yield* ExecutorAdoption
  yield* adopter.probe
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          isNull(connections.companyId),
          or(
            eq(connections.executorPrincipal, 'installation'),
            eq(connections.executorPrincipal, 'adopted'),
          ),
        ),
      ),
  )
  let remaining = false
  for (const raw of rows) {
    const id = ConnectionId.make(raw.id)
    const result = yield* Effect.gen(function* () {
      const prepared = yield* claim(id, prepare)
      if (Outcome.isAnyOf(['Deferred', 'Busy'])(prepared)) return prepared
      const moved = yield* claim(id, move)
      if (Outcome.isAnyOf(['Deferred', 'Busy'])(moved)) return moved
      return yield* claim(id, finalize)
    }).pipe(Effect.result)
    if (Result.isFailure(result)) {
      remaining = true
      if (sourceUnsupported(result.failure))
        yield* Effect.logWarning('Integration source cannot be adopted', {
          connectionId: id,
          reason: result.failure.reason,
        })
      else
        yield* Effect.logWarning('Integration adoption deferred', {
          connectionId: id,
          reason: result.failure._tag,
        })
    } else {
      if (
        Outcome.guards.Busy(result.success) ||
        (Outcome.guards.Deferred(result.success) &&
          result.success.reason === 'PendingAuthorization')
      )
        remaining = true
      yield* Effect.logInfo('Integration adoption', { connectionId: id, outcome: result.success })
    }
  }
  return remaining
})

/** One scoped boot pass, bounded to a day of minute-capped retries. The row marker owns crash
 * recovery; no timer owns correctness. Downtime and unsupported rows never block server launch. */
export const adoptionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Database | Executor | ExecutorMembers | ExecutorAdoption | ExecutorEvents | ServerConfig
    >()
    const pass = adoptConnections().pipe(
      Effect.provideContext(context),
      Effect.catch((failure) =>
        Effect.logWarning('Integration adoption probe failed', { reason: failure._tag }).pipe(
          Effect.as(true),
        ),
      ),
    )
    const backoff = Schedule.exponential('5 seconds').pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(duration, Duration.minutes(1))),
      ),
      Schedule.upTo({ times: 1440 }),
    )
    yield* pass.pipe(
      Effect.repeat({ schedule: backoff, while: (pending) => pending }),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError('Integration adoption worker stopped', cause),
      ),
      Effect.forkScoped,
    )
  }),
)
