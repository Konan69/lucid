import { approvals } from '../approvals/tables.ts'
import { and, desc, eq, gt } from 'drizzle-orm'
import {
  ActivityRegistration,
  ActivitySnapshot,
  Conflict,
  ActivityUnavailable,
  ApprovalId,
  ProposedAction,
  ThreadId,
  type PersonId,
  type SessionId,
} from '@vivid/contracts'
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { sessionTable } from '../auth/tables.ts'
import { optionalSetting } from '../config.ts'
import { Database, decodeStored } from '../database/client.ts'
import { canSee } from '../threads/access.ts'
import { runs, threads } from '../threads/tables.ts'
import { sendActivity, type Credentials } from './apns.ts'
import { activityTargets } from './tables.ts'

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

/** Provider delivery owns its durable start claim and terminal token cleanup. */
const deliverFor = (
  database: Database['Service'],
  authority: Credentials,
  snapshot: ActivitySnapshot,
  ongoing: boolean,
) =>
  Effect.fn('Activities.deliver')(
    function* (target: typeof activityTargets.$inferSelect) {
      const key = and(
        eq(activityTargets.installation, target.installation),
        eq(activityTargets.sessionId, target.sessionId),
      )
      if (target.updateToken !== null) {
        yield* sendActivity(authority, target.updateToken, ongoing ? 'update' : 'end', snapshot)
        if (!ongoing)
          yield* database.run(
            database.update(activityTargets).set({ started: false, updateToken: null }).where(key),
          )
        return
      }
      if (!ongoing || target.startToken === null || target.started) return
      const claimed = yield* database.run(
        database
          .update(activityTargets)
          .set({ started: true })
          .where(and(key, eq(activityTargets.started, false)))
          .returning({ installation: activityTargets.installation }),
      )
      if (claimed.length === 0) return
      yield* sendActivity(authority, target.startToken, 'start', snapshot)
    },
    (effect, target) =>
      effect.pipe(
        Effect.catchTags({
          PushTargetGone: () =>
            Effect.gen(function* () {
              const key = and(
                eq(activityTargets.installation, target.installation),
                eq(activityTargets.sessionId, target.sessionId),
              )
              if (target.updateToken === null) {
                yield* database.run(database.delete(activityTargets).where(key))
              } else {
                yield* database.run(
                  database
                    .update(activityTargets)
                    .set({ updateToken: null, started: false })
                    .where(key),
                )
              }
            }),
          PushRejected: () =>
            Effect.gen(function* () {
              if (target.updateToken === null)
                yield* database.run(
                  database
                    .update(activityTargets)
                    .set({ started: false })
                    .where(
                      and(
                        eq(activityTargets.installation, target.installation),
                        eq(activityTargets.sessionId, target.sessionId),
                      ),
                    ),
                )
              yield* Effect.logWarning('Live Activity push rejected')
            }),
          PushUncertain: () => Effect.logWarning('Live Activity delivery uncertain'),
        }),
      ),
  )

/** Only a still-live session may receive titles, including after a server restart. */
const refreshFor = (database: Database['Service'], signing: Option.Option<Credentials>) =>
  Effect.fn('Activity.refresh')(function* (personId: PersonId) {
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
    const working = yield* database.run(
      database
        .select({ title: threads.title, id: threads.id, startedAt: runs.startedAt })
        .from(runs)
        .innerJoin(threads, eq(runs.threadId, threads.id))
        .where(and(eq(runs.personId, personId), eq(runs.state, 'working')))
        .orderBy(desc(runs.startedAt)),
    )
    const readable = yield* Effect.filter(working, (thread) =>
      canSee(thread.id, personId).pipe(Effect.provideService(Database, database)),
    )
    const first = readable[0]
    const pending = yield* database.run(
      database
        .select({
          id: approvals.id,
          digest: approvals.digest,
          action: approvals.action,
          thread: approvals.threadId,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.personId, personId),
            eq(approvals.status, 'pending'),
            gt(approvals.expiresAt, now),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(1),
    )
    const proposal = pending[0]
    const approval =
      proposal === undefined ||
      !(yield* canSee(ThreadId.make(proposal.thread), personId).pipe(
        Effect.provideService(Database, database),
      ))
        ? null
        : {
            id: ApprovalId.make(proposal.id),
            digest: proposal.digest,
            summary: (yield* decodeStored(ProposedAction, 'activity approval')(proposal.action))
              .summary,
          }
    const ongoing = first !== undefined || approval !== null
    const snapshot = ActivitySnapshot.make({
      approval,
      startedAt: first === undefined ? null : Math.min(...readable.map((run) => run.startedAt)),
      title: first === undefined ? 'Vivid' : first.title,
      status:
        approval !== null ? 'Approval needed' : first === undefined ? 'Work ended' : 'Working',
      activeCount: readable.length,
      updatedAt: now,
    })
    const deliver = deliverFor(database, signing.value, snapshot, ongoing)
    yield* Effect.forEach(targets, ({ target }) => deliver(target))
  })

/** The database owns start claims; a replay or another server cannot start a duplicate activity. */
const make = Effect.fn('Activities.make')(function* () {
  const database = yield* Database
  const signing = yield* credentials()

  const refresh = refreshFor(database, signing)

  /** The installation is bound to its Person and session before any provider token is used. */
  const register = Effect.fn('Activity.register')(function* (
    personId: PersonId,
    sessionId: SessionId,
    request: ActivityRegistration,
  ) {
    if (Option.isNone(signing)) return yield* new ActivityUnavailable({})
    const values = ActivityRegistration.match(request, {
      Start: ({ token }): Partial<typeof activityTargets.$inferInsert> => ({ startToken: token }),
      Update: ({ token }): Partial<typeof activityTargets.$inferInsert> => ({ updateToken: token }),
    })
    const inserted = yield* database.run(
      database
        .insert(activityTargets)
        .values({
          installation: request.installation,
          personId,
          sessionId,
          ...values,
        })
        .onConflictDoUpdate({
          target: activityTargets.installation,
          set: { sessionId, ...values },
          setWhere: eq(activityTargets.personId, personId),
        })
        .returning({ installation: activityTargets.installation }),
    )
    if (inserted.length === 0)
      return yield* new Conflict({ message: 'This installation belongs to another Person.' })
    yield* refresh(personId)
  })
  return { register, refresh }
})

export class Activities extends Context.Service<
  Activities,
  Effect.Success<ReturnType<typeof make>>
>()('vivid/Activities') {}
export const activitiesLayer = Layer.effect(Activities, make())
