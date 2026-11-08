import { Option, Schema } from 'effect'
import { ConnectionState } from './connections.js'
import { ConnectionId, RunId, ThreadId } from './identity.js'
import { ChildBudget, ChildRunState, RunFailure, WorkerKind } from './runs.js'
import { RunOrigin, RunState } from './threads.js'
import { Watch, WatchId, WatchState } from './watches.js'

/**
 * Background work: everything Vivid has going for a Person that is not the reply in front of
 * them, in one list, with where each piece stands and a way to stop it.
 *
 * Ported from Grok Bot's worker registry (`grok-bot/grok-bot.md:136`, `:137`, `:2457`, `:2507`;
 * mined as `mined/grok-bot-prompt.md` P10): a worker that has run unusually long or stopped
 * making progress is stalled and is reported as stalled, not as "still working"; one call stops
 * every worker at once and its result says, for each, whether it was stopped, had already
 * finished, or could not be stopped and why. Here the workers are the things that act for a
 * Person without them: Runs still working, the helpers those Runs handed narrower work to,
 * Watches (check-ins are Watches too), and Integrations Vivid made for itself. A new kind of background work is one more case of `BackgroundWork` and
 * of `WorkRef`; `standingOf` and `stopsWith` then fail to typecheck until it is placed.
 */

/** A Watch that is still live: Stopped and Completed Watches are history, never background work. */
export const LiveWatchState = Schema.Union([
  WatchState.cases.Pending,
  WatchState.cases.Active,
  WatchState.cases.Paused,
])
export type LiveWatchState = typeof LiveWatchState.Type

/** A helper that has not ended: Completed, Failed and Stopped helpers are history. */
export const LiveHelperState = Schema.Union([
  ChildRunState.cases.Reserved,
  ChildRunState.cases.Working,
  ChildRunState.cases.Stopping,
])
export type LiveHelperState = typeof LiveHelperState.Type

/** The last Run a Watch's event started, as much of it as says whether the Watch is working. */
export const WatchFiring = Schema.Struct({ run: RunId, startedAt: Schema.Finite, state: RunState })
export interface WatchFiring extends Schema.Schema.Type<typeof WatchFiring> {}

/**
 * One piece of background work, as its owner reads it. Each case carries the facts its standing
 * is worked out from (`standingOf`), not a verdict, because two of those facts are about time:
 * a Run working too long or a Watch overdue becomes stalled while nothing in the database moves.
 *
 * - `Run`: a Run acting for this Person that is still working, in the Thread it is advancing.
 * - `Helper`: a helper Run (`ChildRun`) one of those Runs started and that has not ended.
 * - `Watch`: a live Watch, with its Integration's state and the last Run one of its events started;
 *   `purpose` says whether it waits on an event or is a check-in Vivid timed for itself.
 * - `MadeIntegration`: an Integration Vivid wrote for itself (`make_integration`), with how many
 *   live Watches listen to it; on its own it never wakes Vivid.
 */
export const BackgroundWork = Schema.TaggedUnion({
  Run: {
    run: RunId,
    thread: ThreadId,
    /** The Thread's title, which is how the Person knows what the Run is for. */
    title: Schema.String,
    origin: RunOrigin,
    startedAt: Schema.Finite,
  },
  Helper: {
    helper: RunId,
    thread: ThreadId,
    /** The parent's Thread title, which is what the helper's work is for. */
    title: Schema.String,
    /** "Helper 2" in its Thread; the model and the Person know a helper by it. */
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    kind: WorkerKind,
    brief: Schema.String,
    budget: ChildBudget,
    state: LiveHelperState,
    requestedAt: Schema.Finite,
  },
  Watch: {
    watch: WatchId,
    name: Watch.fields.name,
    account: Watch.fields.account,
    instruction: Watch.fields.instruction,
    purpose: Watch.fields.purpose,
    state: LiveWatchState,
    createdAt: Schema.Finite,
    integration: ConnectionState,
    /** Null until one of its events has woken Vivid. */
    lastFiring: Schema.NullOr(WatchFiring),
  },
  MadeIntegration: {
    connection: ConnectionId,
    account: Schema.String,
    state: ConnectionState,
    /** How many live Watches listen to its events: zero means nothing it does reaches Vivid. */
    watches: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    createdAt: Schema.Finite,
  },
})
export type BackgroundWork = typeof BackgroundWork.Type

/** A Person's background work, newest first within each kind: Runs, helpers, Watches, made Integrations. */
export const WorkListResponse = Schema.Struct({ work: Schema.Array(BackgroundWork) })
export interface WorkListResponse extends Schema.Schema.Type<typeof WorkListResponse> {}

/**
 * Why a piece of work is stalled: it has not failed, but it is not getting anywhere.
 *
 * - `WorkingLong`: a Run has been working since `since` and is past `RUN_WORKING_LONG_MS`, or a
 *   helper is past its own time budget, after which the runtime should already have ended it.
 * - `Paused`: a Watch was paused at `since` because its Integration needs the Person to sign in
 *   again (`watches/progress.ts`); it resumes when they do.
 * - `NotConfirmed`: a Watch's subscription was never confirmed by its Integration.
 * - `NotRenewed`: a Watch's subscription ran out at `since` and renewal has not got through, so
 *   events since then may not have reached Vivid (`apps/server/src/watches/lifecycle.ts` keeps
 *   trying; it does not stop a Watch for an unreachable Executor).
 */
export const WorkStall = Schema.TaggedUnion({
  WorkingLong: { since: Schema.Finite },
  Paused: { since: Schema.Finite },
  NotConfirmed: { since: Schema.Finite },
  NotRenewed: { since: Schema.Finite },
})
export type WorkStall = typeof WorkStall.Type

/**
 * Why a piece of work is failing: something it depends on is broken now.
 *
 * - `LastRunFailed`: the last Run a Watch's event started failed, for `reason`.
 * - `IntegrationNeedsSignIn`: its Integration's sign-in lapsed or was never finished.
 * - `IntegrationFailed`: its Integration failed for `reason`, the provider's own words.
 */
export const WorkFailure = Schema.TaggedUnion({
  LastRunFailed: { at: Schema.Finite, reason: RunFailure },
  IntegrationNeedsSignIn: {},
  IntegrationFailed: { reason: Schema.String },
})
export type WorkFailure = typeof WorkFailure.Type

/** Where a piece of work stands. Failing outranks stalled: a broken dependency is the thing to fix. */
export const WorkStanding = Schema.TaggedUnion({
  Going: {},
  Stalled: { stall: WorkStall },
  Failing: { failure: WorkFailure },
})
export type WorkStanding = typeof WorkStanding.Type

/**
 * How long a Run may work before it reads as stalled. Grok Bot's rule is "unusually long" with no
 * number (`grok-bot/grok-bot.md:136`); a reply with research or a Computer job takes minutes, and
 * twenty is past the longest one that is still going somewhere. UX policy, not a deadline: nothing
 * ends a Run for crossing it.
 */
export const RUN_WORKING_LONG_MS = 20 * 60_000

/**
 * How long a Watch may stay Pending before it reads as stalled: the renewal pass that finishes a
 * Pending Watch runs every ten minutes after a one-minute grace (`watches/lifecycle.ts` `renew`,
 * `RECOVER_AFTER_MS`), so two missed passes mean the Integration is not confirming it.
 */
export const WATCH_UNCONFIRMED_MS = 21 * 60_000

/** An Integration's own state as a failure, when it is one. */
const integrationFailure = (state: ConnectionState): Option.Option<WorkFailure> =>
  ConnectionState.match(state, {
    Ready: () => Option.none(),
    NeedsAuthorization: () => Option.some(WorkFailure.cases.IntegrationNeedsSignIn.make({})),
    Failed: ({ reason }) => Option.some(WorkFailure.cases.IntegrationFailed.make({ reason })),
  })

const failing = (failure: WorkFailure): WorkStanding => WorkStanding.cases.Failing.make({ failure })
const stalled = (stall: WorkStall): WorkStanding => WorkStanding.cases.Stalled.make({ stall })
const going = (): WorkStanding => WorkStanding.cases.Going.make({})

/**
 * A Watch's standing: paused first (its own reason already names the Integration), then its
 * Integration, then its last firing, then its subscription.
 */
const watchStanding = (
  watch: Extract<BackgroundWork, { _tag: 'Watch' }>,
  now: number,
): WorkStanding => {
  if (WatchState.guards.Paused(watch.state))
    return stalled(WorkStall.cases.Paused.make({ since: watch.state.at }))
  const broken = integrationFailure(watch.integration)
  if (Option.isSome(broken)) return failing(broken.value)
  const firing = watch.lastFiring
  if (firing !== null && RunState.guards.Failed(firing.state))
    return failing(
      WorkFailure.cases.LastRunFailed.make({
        at: firing.state.finishedAt,
        reason: firing.state.reason,
      }),
    )
  if (WatchState.guards.Pending(watch.state))
    return now - watch.createdAt > WATCH_UNCONFIRMED_MS
      ? stalled(WorkStall.cases.NotConfirmed.make({ since: watch.createdAt }))
      : going()
  return now > watch.state.refreshBefore
    ? stalled(WorkStall.cases.NotRenewed.make({ since: watch.state.refreshBefore }))
    : going()
}

/**
 * Where a piece of work stands at `now`. Every surface and the model's tool read it through this
 * one function, so "stalled" means the same thing on the phone, the web and in Vivid's words.
 */
export const standingOf = (work: BackgroundWork, now: number): WorkStanding =>
  BackgroundWork.match(work, {
    Run: ({ startedAt }) =>
      now - startedAt > RUN_WORKING_LONG_MS
        ? stalled(WorkStall.cases.WorkingLong.make({ since: startedAt }))
        : going(),
    Helper: ({ state, requestedAt, budget }) => {
      const since = ChildRunState.guards.Working(state) ? state.startedAt : requestedAt
      return now - since > budget.seconds * 1000
        ? stalled(WorkStall.cases.WorkingLong.make({ since }))
        : going()
    },
    Watch: (watch) => watchStanding(watch, now),
    MadeIntegration: ({ state }) =>
      Option.match(integrationFailure(state), { onNone: going, onSome: failing }),
  })

/** Which piece of background work a Stop names. */
export const WorkRef = Schema.TaggedUnion({
  Run: { run: RunId },
  Helper: { helper: RunId },
  Watch: { watch: WatchId },
  MadeIntegration: { connection: ConnectionId },
})
export type WorkRef = typeof WorkRef.Type

/** The reference a listed piece of work is stopped by. */
export const refOf = (work: BackgroundWork): WorkRef =>
  BackgroundWork.match(work, {
    Run: ({ run }): WorkRef => WorkRef.cases.Run.make({ run }),
    Helper: ({ helper }): WorkRef => WorkRef.cases.Helper.make({ helper }),
    Watch: ({ watch }): WorkRef => WorkRef.cases.Watch.make({ watch }),
    MadeIntegration: ({ connection }): WorkRef =>
      WorkRef.cases.MadeIntegration.make({ connection }),
  })

/**
 * What stopping a piece of work does. `Stop` ends it and nothing is lost: a Run is interrupted, a
 * Watch unsubscribed. `Remove` deletes what Vivid wrote, which cannot be undone, so it is never part
 * of Stop everything: once every Watch is stopped, a made Integration no longer reaches Vivid.
 */
export type WorkStop = 'Stop' | 'Remove'

/** How each kind of work is stopped. */
export const stopsWith = (work: BackgroundWork): WorkStop =>
  BackgroundWork.match(work, {
    Run: (): WorkStop => 'Stop',
    Helper: (): WorkStop => 'Stop',
    Watch: (): WorkStop => 'Stop',
    MadeIntegration: (): WorkStop => 'Remove',
  })

/**
 * Why a Stop did not take. `RuntimeUnreachable`: the Run is marked stopped but the runtime did not
 * answer the interrupt, so it may still be working. `IntegrationsUnreachable`: Executor could not
 * remove a made Integration right now.
 */
export const WorkNotStopped = Schema.Literals(['RuntimeUnreachable', 'IntegrationsUnreachable'])
export type WorkNotStopped = typeof WorkNotStopped.Type

/**
 * What one Stop did. `Stopped`: this call ended it. `AlreadyEnded`: it had finished or been
 * stopped before this call reached it, which is not a failure. `NotStopped`: see `WorkNotStopped`.
 */
export const WorkStopResult = Schema.TaggedUnion({
  Stopped: {},
  AlreadyEnded: {},
  NotStopped: { reason: WorkNotStopped },
})
export type WorkStopResult = typeof WorkStopResult.Type

export const StopWorkResponse = Schema.Struct({ result: WorkStopResult })
export interface StopWorkResponse extends Schema.Schema.Type<typeof StopWorkResponse> {}

/** One line of Stop everything's report: the work as it was listed, and what stopping it did. */
export const WorkStopReport = Schema.Struct({ work: BackgroundWork, result: WorkStopResult })
export interface WorkStopReport extends Schema.Schema.Type<typeof WorkStopReport> {}

/**
 * Stop everything's report, line by line, as Grok Bot's `StopSubagent {all:true}` answers: what was
 * stopped, what had already finished and what could not be stopped and why. Work that stops with
 * `Remove` is not touched and not reported. When the caller is Vivid inside a Run, that Run's own
 * Thread is left alone so it can say what was stopped.
 */
export const StopAllWorkResponse = Schema.Struct({ stopped: Schema.Array(WorkStopReport) })
export interface StopAllWorkResponse extends Schema.Schema.Type<typeof StopAllWorkResponse> {}
