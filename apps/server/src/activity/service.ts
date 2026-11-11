import { approvals } from '../approvals/tables.ts'
import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import {
  ActivityRegistration,
  ActivityRow,
  ActivitySnapshot,
  Conflict,
  ActivityUnavailable,
  ApprovalId,
  ProposedAction,
  draftOf,
  ThreadId,
  type PersonId,
  type SessionId,
} from '@vivid/contracts'
import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect'
import { sessionTable } from '../auth/tables.ts'
import { optionalSetting } from '../config.ts'
import { Database, decodeStored } from '../database/client.ts'
import { readableBy } from '../threads/access.ts'
import { runs, threads } from '../threads/tables.ts'
import { ActivityPush, activityPushLayer, type Credentials } from './apns.ts'
import { activityTargets } from './tables.ts'

const decodeApprovalAction = decodeStored(ProposedAction, 'activity approval')

/** A card shows three Threads at most; more would not fit the Lock Screen's ~160 points. */
const MAX_ROWS = 3
/**
 * A Run that ended this recently stays on the card as its outcome. T3 Code keeps finished work
 * visible for the same fifteen minutes (`agentActivityAggregate.ts`
 * `TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS`).
 */
const RECENT_OUTCOME_MS = 15 * 60 * 1000
/**
 * An unchanged card is not pushed again sooner than this. Content that did not change gains
 * nothing from a push but spends the APNs budget; the repeat only renews the card's freshness
 * (`apns.ts` `STALE_AFTER_SECONDS`, ten minutes) well before it runs out.
 */
const RESEND_UNCHANGED_MS = 4 * 60 * 1000

/** The line each Thread shows under its title, by Thread id: a step while working, then a result. */
type Lines = ReadonlyMap<string, string>
const lineOf = (lines: Lines, thread: string) =>
  Option.getOrNull(Option.fromUndefinedOr(lines.get(thread)))

/** What was last pushed to each update token, without its time, and when. */
type Sent = Map<string, { readonly content: string; readonly at: number }>
const contentOf = (snapshot: ActivitySnapshot) => JSON.stringify({ ...snapshot, updatedAt: 0 })

/** APNs signing authority stays server-side and is absent from unsigned development stacks. */
const credentials = Effect.fn('Activities.credentials')(function* () {
  const key = yield* optionalSetting(
    'VIVID_APNS_PRIVATE_KEY',
    Schema.RedactedFromValue(Schema.NonEmptyString),
  )
  if (Option.isNone(key)) return Option.none<Credentials>()
  const team = yield* optionalSetting('VIVID_APNS_TEAM_ID', Schema.NonEmptyString)
  const keyId = yield* optionalSetting('VIVID_APNS_KEY_ID', Schema.NonEmptyString)
  const bundle = yield* optionalSetting('VIVID_APNS_BUNDLE_ID', Schema.NonEmptyString)
  const environment = yield* optionalSetting(
    'VIVID_APNS_ENVIRONMENT',
    Schema.Literals(['production', 'sandbox']),
  )
  if (
    Option.isNone(team) ||
    Option.isNone(keyId) ||
    Option.isNone(bundle) ||
    Option.isNone(environment)
  )
    return yield* new Conflict({ message: 'APNs configuration is incomplete.' })
  return Option.some({
    team: team.value,
    keyId: keyId.value,
    key: Redacted.make(Redacted.value(key.value)),
    bundle: bundle.value,
    environment: environment.value,
  })
})

interface DeliveryServices {
  readonly database: Database['Service']
  readonly sender: ActivityPush['Service']
  readonly lines: Ref.Ref<Lines>
  readonly sent: Ref.Ref<Sent>
}

/**
 * Updates or ends the one card an installation shows. A target with no update token has no card
 * the server may touch, and nothing is ever started from here: the app starts the card in the
 * foreground and registers its token (`@vivid/contracts` `ActivityRegistration`). With nothing
 * live the card is ended with its outcome and forgets its token, so the next Run's card is a new
 * one the app starts, never a resurrected old one.
 */
const deliverFor = (
  services: DeliveryServices,
  authority: Credentials,
  snapshot: ActivitySnapshot,
) =>
  Effect.fn('Activities.deliver')(
    function* (target: typeof activityTargets.$inferSelect) {
      const { database, sender } = services
      if (target.updateToken === null) return
      const ongoing = snapshot.activeCount > 0
      const content = contentOf(snapshot)
      const last = (yield* Ref.get(services.sent)).get(target.updateToken)
      if (
        ongoing &&
        last !== undefined &&
        last.content === content &&
        snapshot.updatedAt - last.at < RESEND_UNCHANGED_MS
      )
        return
      yield* sender.send(authority, target.updateToken, ongoing ? 'update' : 'end', snapshot)
      const token = target.updateToken
      yield* Ref.update(services.sent, (all) =>
        new Map(all).set(token, { content, at: snapshot.updatedAt }),
      )
      if (!ongoing) yield* forget(database, target.installation, target.updateToken)
    },
    (effect, target) =>
      effect.pipe(
        Effect.catchTags({
          // The card is gone (dismissed, or the app removed). A newer token is never cleared.
          PushTargetGone: () =>
            Effect.gen(function* () {
              if (target.updateToken !== null)
                yield* forget(services.database, target.installation, target.updateToken)
            }),
          PushRejected: () => Effect.logWarning('Live Activity push rejected'),
          PushUncertain: () => Effect.logWarning('Live Activity delivery uncertain'),
        }),
      ),
  )

/** Clears an installation's token only if it is still the one this delivery used. */
const forget = (database: Database['Service'], installation: string, token: string) =>
  database.run(
    database
      .update(activityTargets)
      .set({ updateToken: null })
      .where(
        and(eq(activityTargets.installation, installation), eq(activityTargets.updateToken, token)),
      ),
  )

/** Working Runs in Threads the Person can read now, one row per Thread, newest first. */
const workingRows = Effect.fn('Activity.workingRows')(function* (
  database: Database['Service'],
  personId: PersonId,
  lines: Lines,
) {
  const working = yield* database.run(
    database
      .select({ thread: threads.id, title: threads.title })
      .from(runs)
      .innerJoin(threads, eq(runs.threadId, threads.id))
      .where(and(eq(runs.personId, personId), eq(runs.state, 'working'), readableBy(personId)))
      .orderBy(desc(runs.startedAt), desc(runs.id)),
  )
  return distinctThreads(working).map((row) =>
    ActivityRow.make({
      ...row,
      thread: ThreadId.make(row.thread),
      phase: 'Working',
      line: lineOf(lines, row.thread),
    }),
  )
})

/** Runs that ended in the last few minutes, as outcomes. A Run the Person stopped is no outcome. */
const outcomeRows = Effect.fn('Activity.outcomeRows')(function* (
  database: Database['Service'],
  personId: PersonId,
  now: number,
  lines: Lines,
) {
  const ended = yield* database.run(
    database
      .select({ thread: threads.id, title: threads.title, state: runs.state })
      .from(runs)
      .innerJoin(threads, eq(runs.threadId, threads.id))
      .where(
        and(
          eq(runs.personId, personId),
          inArray(runs.state, ['completed', 'failed']),
          gt(runs.finishedAt, now - RECENT_OUTCOME_MS),
          readableBy(personId),
        ),
      )
      .orderBy(desc(runs.finishedAt), desc(runs.id)),
  )
  return distinctThreads(ended).map(({ state, ...row }) =>
    ActivityRow.make({
      ...row,
      thread: ThreadId.make(row.thread),
      phase: state === 'failed' ? 'Failed' : 'Done',
      line: lineOf(lines, row.thread),
    }),
  )
})

/** The newest pending approval in a readable Thread, with what the card needs to answer it. */
const pendingApproval = Effect.fn('Activity.pendingApproval')(function* (
  database: Database['Service'],
  personId: PersonId,
  now: number,
) {
  const pending = yield* database.run(
    database
      .select({
        id: approvals.id,
        digest: approvals.digest,
        action: approvals.action,
        thread: approvals.threadId,
        title: threads.title,
      })
      .from(approvals)
      .innerJoin(threads, eq(approvals.threadId, threads.id))
      .where(
        and(
          eq(approvals.personId, personId),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, now),
          readableBy(personId),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1),
  )
  const proposal = pending[0]
  if (proposal === undefined) return Option.none()
  const action = yield* decodeApprovalAction(proposal.action)
  return Option.some({
    approval: {
      id: ApprovalId.make(proposal.id),
      digest: proposal.digest,
      summary: action.summary,
      review: Option.isSome(draftOf(action)),
    },
    row: ActivityRow.make({
      thread: ThreadId.make(proposal.thread),
      title: proposal.title,
      phase: 'Approval',
      line: null,
    }),
  })
})

/** Keeps the first row of each Thread; the queries order rows so the first is the one to show. */
const distinctThreads = <Row extends { readonly thread: string }>(rows: ReadonlyArray<Row>) =>
  rows.filter((row, index) => rows.findIndex((other) => other.thread === row.thread) === index)

/**
 * The card's content for one Person: what waits on them first, then what Vivid is working on,
 * then what just finished. A Thread appears once, in its most urgent phase.
 */
const snapshotFor = Effect.fn('Activity.snapshot')(function* (
  database: Database['Service'],
  personId: PersonId,
  now: number,
  lines: Lines,
) {
  const waiting = yield* pendingApproval(database, personId, now)
  const working = yield* workingRows(database, personId, lines)
  const outcomes = yield* outcomeRows(database, personId, now, lines)
  const live = distinctThreads([...Option.toArray(waiting).map(({ row }) => row), ...working])
  const shown = new Set(live.map((row) => row.thread))
  return ActivitySnapshot.make({
    rows: [...live, ...outcomes.filter((row) => !shown.has(row.thread))].slice(0, MAX_ROWS),
    activeCount: live.length,
    updatedAt: now,
    approval: Option.match(waiting, { onNone: () => null, onSome: ({ approval }) => approval }),
  })
})

/** Only a still-live session may receive titles, including after a server restart. */
const refreshFor = (services: DeliveryServices, signing: Option.Option<Credentials>) =>
  Effect.fn('Activity.refresh')(function* (personId: PersonId) {
    const { database } = services
    if (Option.isNone(signing)) return
    const now = yield* Clock.currentTimeMillis
    const targets = yield* database.run(
      database
        .select({ target: activityTargets })
        .from(activityTargets)
        .innerJoin(sessionTable, eq(activityTargets.sessionId, sessionTable.id))
        .where(
          and(eq(activityTargets.personId, personId), gt(sessionTable.expiresAt, new Date(now))),
        ),
    )
    if (targets.every(({ target }) => target.updateToken === null)) return
    const snapshot = yield* snapshotFor(database, personId, now, yield* Ref.get(services.lines))
    const deliver = deliverFor(services, signing.value, snapshot)
    yield* Effect.forEach(targets, ({ target }) => deliver(target))
  })

/** Registration replays the current content at once, which also ends a card nothing needs. */
export const makeActivities = Effect.fn('Activities.make')(function* () {
  const database = yield* Database
  const signing = yield* credentials()
  const sender = yield* ActivityPush
  const lines = yield* Ref.make<Lines>(new Map())
  const sent = yield* Ref.make<Sent>(new Map())

  const refresh = refreshFor({ database, sender, lines, sent }, signing)

  /**
   * Sets or clears the line a Thread's row shows (`threads/delivery.ts` reads it from the Thread
   * while a Run works and when it ends). Kept in memory: after a restart a row shows no line until
   * the next step is read, which is a missing detail, never a wrong one.
   */
  const note = (thread: string, line: Option.Option<string>) =>
    Ref.update(lines, (all) => {
      const next = new Map(all)
      Option.match(line, {
        onNone: () => next.delete(thread),
        onSome: (said) => next.set(thread, said),
      })
      return next
    })

  /** The installation is bound to its Person and session before any provider token is used. */
  const register = Effect.fn('Activity.register')(function* (
    personId: PersonId,
    sessionId: SessionId,
    request: ActivityRegistration,
  ) {
    if (Option.isNone(signing)) return yield* new ActivityUnavailable({})
    const inserted = yield* database.run(
      database
        .insert(activityTargets)
        .values({
          installation: request.installation,
          personId,
          sessionId,
          updateToken: request.token,
        })
        .onConflictDoUpdate({
          target: activityTargets.installation,
          set: { sessionId, updateToken: request.token },
          setWhere: eq(activityTargets.personId, personId),
        })
        .returning({ installation: activityTargets.installation }),
    )
    if (inserted.length === 0)
      return yield* new Conflict({ message: 'This installation belongs to another Person.' })
    yield* refresh(personId)
  })
  return { register, refresh, note }
})

export class Activities extends Context.Service<
  Activities,
  Effect.Success<ReturnType<typeof makeActivities>>
>()('vivid/Activities') {}
export const activitiesLayer = Layer.effect(Activities, makeActivities()).pipe(
  Layer.provide(activityPushLayer),
)
