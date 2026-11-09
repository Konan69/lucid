import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  BackgroundWork,
  ChildRunState,
  ConnectionState,
  DatabaseFailure,
  type LiveHelperState,
  type LiveWatchState,
  WatchState,
  type ConnectionId,
  type WatchFiring,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { runningCommands } from '../computers/background.ts'
import { namedAccounts } from '../connections/names.ts'
import { connectionOrigin, listRecords, stateOf } from '../connections/records.ts'
import { liveHelpers } from '../runs/store.ts'
import { lastWatchFirings, workingRuns } from '../threads/runs.ts'
import { WatchStore, type WatchRecord } from '../watches/store.ts'

/**
 * The Integrations this Actor can use, each with the name it has among them and its state. Read
 * from the rows, not `ConnectionStore.list`, which also asks Executor's catalogue for marks: this
 * list reloads on every turn of every Thread the Person can see, and needs none of that.
 */
const integrations = Effect.fn('Work.integrations')(function* (actor: Actor) {
  return yield* Effect.forEach(
    namedAccounts(yield* listRecords(actor)),
    Effect.fnUntraced(function* ({ row, account }) {
      return { row, account, state: yield* stateOf(row) }
    }),
  )
})

/**
 * A listed Watch as background work. The store lists only live Watches and names each from the
 * same Integration rows read here, so a Stopped state or a missing Integration is a database
 * fault, not something to leave out quietly.
 */
const watchWork = (
  record: WatchRecord & { readonly watch: { readonly account: string } },
  integration: Option.Option<ConnectionState>,
  lastFiring: Option.Option<WatchFiring>,
) =>
  Effect.gen(function* () {
    if (Option.isNone(integration))
      return yield* new DatabaseFailure({ message: 'A live Watch has no Integration' })
    const listed = record.watch.state
    if (WatchState.guards.Stopped(listed) || WatchState.guards.Completed(listed))
      return yield* new DatabaseFailure({ message: 'A listed Watch has ended' })
    const state: LiveWatchState = listed
    return BackgroundWork.cases.Watch.make({
      watch: record.watch.id,
      name: record.watch.name,
      account: record.watch.account,
      instruction: record.watch.instruction,
      purpose: record.watch.purpose,
      state,
      createdAt: record.watch.createdAt,
      integration: integration.value,
      lastFiring: Option.getOrNull(lastFiring),
    })
  })

/**
 * A helper that has not ended, as background work. The reader selects only Reserved, Working and
 * Stopping helpers, so an ended one here is a database fault.
 */
const helperWork = ({ run, title }: Effect.Success<ReturnType<typeof liveHelpers>>[number]) =>
  Effect.gen(function* () {
    const state = run.state
    if (
      ChildRunState.guards.Completed(state) ||
      ChildRunState.guards.Failed(state) ||
      ChildRunState.guards.Stopped(state)
    )
      return yield* new DatabaseFailure({ message: 'A listed helper has ended' })
    const live: LiveHelperState = state
    return BackgroundWork.cases.Helper.make({
      helper: run.id,
      thread: run.threadId,
      title,
      number: run.number,
      kind: run.kind,
      brief: run.brief,
      budget: run.budget,
      state: live,
      requestedAt: run.requestedAt,
    })
  })

/**
 * Everything Vivid has going for this Actor besides the reply in front of them: Runs still
 * working (newest first), their helpers that have not ended, the commands Vivid left running on
 * their Computer as the server last read them (newest first; the Computer is not asked), live Watches with their Integration's state and last firing (newest
 * first), and the Integrations Vivid made for itself with how many Watches listen to each. One
 * read per kind; each reader works out standing from these facts (`standingOf`).
 */
export const listWork = Effect.fn('Work.list')(function* (actor: Actor) {
  const runs = yield* workingRuns(actor)
  const helpers = yield* Effect.forEach(yield* liveHelpers(actor), helperWork)
  const commands = yield* runningCommands(actor)
  const watches = yield* (yield* WatchStore).list(actor)
  const accounts = yield* integrations(actor)
  const firings = yield* lastWatchFirings(
    actor.person.id,
    watches.map((record) => record.watch.id),
  )
  const integrationState = (id: ConnectionId) =>
    Option.map(
      Option.fromUndefinedOr(accounts.find(({ row }) => row.id === id)),
      ({ state }) => state,
    )
  const watching = yield* Effect.forEach(watches.toReversed(), (record) =>
    watchWork(
      record,
      integrationState(record.connectionId),
      Option.fromUndefinedOr(firings.get(record.watch.id)),
    ),
  )
  const made = accounts
    .filter(({ row }) => connectionOrigin(row.service) === 'Made')
    .map(({ row, account, state }) =>
      BackgroundWork.cases.MadeIntegration.make({
        connection: row.id,
        account,
        state,
        watches: watches.filter((record) => record.connectionId === row.id).length,
        createdAt: row.createdAt,
      }),
    )
  return [
    ...runs.map((run) => BackgroundWork.cases.Run.make(run)),
    ...helpers,
    ...commands,
    ...watching,
    ...made,
  ]
})
