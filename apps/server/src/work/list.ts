import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  BackgroundWork,
  ConnectionState,
  DatabaseFailure,
  type LiveWatchState,
  WatchState,
  type ConnectionId,
  type WatchFiring,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { namedAccounts } from '../connections/names.ts'
import { connectionOrigin, listRecords, stateOf } from '../connections/records.ts'
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
    if (WatchState.guards.Stopped(listed))
      return yield* new DatabaseFailure({ message: 'A listed Watch is Stopped' })
    const state: LiveWatchState = listed
    return BackgroundWork.cases.Watch.make({
      watch: record.watch.id,
      name: record.watch.name,
      account: record.watch.account,
      instruction: record.watch.instruction,
      state,
      createdAt: record.watch.createdAt,
      integration: integration.value,
      lastFiring: Option.getOrNull(lastFiring),
    })
  })

/**
 * Everything Vivid has going for this Actor besides the reply in front of them: Runs still
 * working (newest first), live Watches with their Integration's state and last firing (newest
 * first), and the Integrations Vivid made for itself with how many Watches listen to each. One
 * read per kind; each reader works out standing from these facts (`standingOf`).
 */
export const listWork = Effect.fn('Work.list')(function* (actor: Actor) {
  const runs = yield* workingRuns(actor)
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
  return [...runs.map((run) => BackgroundWork.cases.Run.make(run)), ...watching, ...made]
})
