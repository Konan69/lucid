import { approvals } from '../approvals/tables.ts'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import {
  ActivityRegistration,
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
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import { sessionTable } from '../auth/tables.ts'
import { optionalSetting } from '../config.ts'
import { Database, decodeStored } from '../database/client.ts'
import { canSee } from '../threads/access.ts'
import { runs, threads } from '../threads/tables.ts'
import { ActivityPush, activityPushLayer, type Credentials } from './apns.ts'
import { activityTargets, type ActivityStartKey } from './tables.ts'

const decodeApprovalAction = decodeStored(ProposedAction, 'activity approval')

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
}

/** Provider delivery owns its durable start claim and terminal token cleanup. */
const deliverFor = (
  services: DeliveryServices,
  authority: Credentials,
  snapshot: ActivitySnapshot,
  work: ActivityStartKey | null,
) =>
  Effect.fn('Activities.deliver')(
    function* (target: typeof activityTargets.$inferSelect) {
      const { database, sender } = services
      const ongoing = work !== null
      const key = and(
        eq(activityTargets.installation, target.installation),
        eq(activityTargets.sessionId, target.sessionId),
      )
      if (target.updateToken !== null) {
        yield* sender.send(authority, target.updateToken, ongoing ? 'update' : 'end', snapshot)
        if (!ongoing)
          yield* database.run(
            database
              .update(activityTargets)
              .set({ startKey: null, updateToken: null })
              .where(and(key, eq(activityTargets.updateToken, target.updateToken))),
          )
        return
      }
      if (work === null || target.startToken === null || target.startKey === work) return
      const claimed = yield* database.run(
        database
          .update(activityTargets)
          .set({ startKey: work })
          .where(
            and(
              key,
              isNull(activityTargets.updateToken),
              eq(activityTargets.startToken, target.startToken),
              target.startKey === null
                ? isNull(activityTargets.startKey)
                : eq(activityTargets.startKey, target.startKey),
            ),
          )
          .returning({ installation: activityTargets.installation }),
      )
      if (claimed.length === 0) return
      yield* sender.send(authority, target.startToken, 'start', snapshot)
    },
    (effect, target) =>
      effect.pipe(
        Effect.catchTags({
          PushTargetGone: () =>
            Effect.gen(function* () {
              const { database } = services
              const key = and(
                eq(activityTargets.installation, target.installation),
                eq(activityTargets.sessionId, target.sessionId),
              )
              if (target.updateToken !== null) {
                yield* database.run(
                  database
                    .update(activityTargets)
                    .set({ updateToken: null, startKey: null })
                    .where(and(key, eq(activityTargets.updateToken, target.updateToken))),
                )
              } else if (target.startToken !== null) {
                yield* database.run(
                  database
                    .delete(activityTargets)
                    .where(
                      and(
                        key,
                        eq(activityTargets.startToken, target.startToken),
                        isNull(activityTargets.updateToken),
                      ),
                    ),
                )
              }
            }),
          PushRejected: () =>
            Effect.gen(function* () {
              const { database } = services
              if (target.updateToken === null && target.startToken !== null && work !== null)
                yield* database.run(
                  database
                    .update(activityTargets)
                    .set({ startKey: null })
                    .where(
                      and(
                        eq(activityTargets.installation, target.installation),
                        eq(activityTargets.sessionId, target.sessionId),
                        eq(activityTargets.startToken, target.startToken),
                        eq(activityTargets.startKey, work),
                        isNull(activityTargets.updateToken),
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
    const working = yield* database.run(
      database
        .select({ title: threads.title, id: threads.id, startedAt: runs.startedAt, run: runs.id })
        .from(runs)
        .innerJoin(threads, eq(runs.threadId, threads.id))
        .where(and(eq(runs.personId, personId), eq(runs.state, 'working')))
        .orderBy(desc(runs.startedAt), desc(runs.id)),
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
        : yield* decodeApprovalAction(proposal.action).pipe(
            Effect.map((action) => ({
              id: ApprovalId.make(proposal.id),
              digest: proposal.digest,
              summary: action.summary,
              review: Option.isSome(draftOf(action)),
            })),
          )
    const snapshot = ActivitySnapshot.make({
      approval,
      startedAt: first === undefined ? null : Math.min(...readable.map((run) => run.startedAt)),
      title: first === undefined ? 'Vivid' : first.title,
      status:
        approval !== null ? 'Approval needed' : first === undefined ? 'Work ended' : 'Working',
      activeCount: readable.length,
      updatedAt: now,
    })
    const oldest = readable.at(-1)
    const work: ActivityStartKey | null =
      oldest !== undefined
        ? `run:${oldest.run}`
        : approval !== null
          ? `approval:${approval.id}`
          : null
    const deliver = deliverFor(services, signing.value, snapshot, work)
    yield* Effect.forEach(targets, ({ target }) => deliver(target))
  })

/** The database owns start claims; a replay or another server cannot start a duplicate activity. */
export const makeActivities = Effect.fn('Activities.make')(function* () {
  const database = yield* Database
  const signing = yield* credentials()
  const sender = yield* ActivityPush

  const refresh = refreshFor({ database, sender }, signing)

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
  Effect.Success<ReturnType<typeof makeActivities>>
>()('vivid/Activities') {}
export const activitiesLayer = Layer.effect(Activities, makeActivities()).pipe(
  Layer.provide(activityPushLayer),
)
