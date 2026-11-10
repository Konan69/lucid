import * as NodeCrypto from 'node:crypto'
import { and, eq, gt, lte, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import { Clock, Context, Effect, Layer } from 'effect'
import {
  Conflict,
  InvalidRequest,
  PersonId,
  PushDestination,
  PushTarget,
  PushTargetId,
  SessionId,
  Unauthenticated,
} from '@vivid/contracts'
import { Database, decodeStored, encodeStored, returned } from '../database/client.ts'
import { sessionTable } from '../auth/tables.ts'
import { Changes, Topic } from '../live/changes.ts'
import { pushTargets } from './tables.ts'

const TargetRow = createSelectSchema(pushTargets, {
  id: PushTargetId,
  personId: PersonId,
  sessionId: SessionId,
  destination: PushDestination,
})
const decodeTarget = decodeStored(TargetRow, 'push target')
const encodeDestination = encodeStored(PushDestination, 'push destination')

/**
 * Restrict Web Push to public provider hosts, so arbitrary subscriptions cannot become SSRF.
 * Chrome 151 subscribes at `https://jmt17.google.com/fcm/send/…` (seen on a devbox on 29 October
 * 2026), Google's own push service beside `fcm.googleapis.com`.
 */
const providerHost = (hostname: string) =>
  [
    'fcm.googleapis.com',
    'jmt17.google.com',
    'updates.push.services.mozilla.com',
    'web.push.apple.com',
  ].includes(hostname) ||
  (hostname.endsWith('.notify.windows.com') && hostname !== '.notify.windows.com')

/** The endpoint is authority to send only to a supported public push provider, without redirects. */
const validateDestination = Effect.fn('PushTargets.validate')(function* (
  destination: PushDestination,
) {
  if (PushDestination.guards.Phone(destination)) return
  const url = yield* Effect.try({
    try: () => new URL(destination.endpoint),
    catch: () => new InvalidRequest({ message: 'Invalid push endpoint.' }),
  })
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    !providerHost(url.hostname)
  )
    return yield* new InvalidRequest({ message: 'Unsupported push provider endpoint.' })
})

/** Provider credentials are never copied into identifiers, ownership fields or model results. */
const addressHash = (destination: PushDestination) =>
  NodeCrypto.createHash('sha256')
    .update(
      PushDestination.match(destination, {
        Browser: ({ endpoint }) => endpoint,
        Phone: ({ token }) => token,
      }),
    )
    .digest('hex')

/** Persistence owns session checks and endpoint uniqueness, independent of RPC and network APIs. */
const makeTargets = (database: Database['Service'], changes: Changes['Service']) => {
  /** A session expiry has no delete hook; pruning at every read prevents stale subscriptions. */
  const active = Effect.fn('PushTargets.active')(function* (personId: PersonId) {
    const now = yield* Clock.currentTimeMillis
    const expired = database
      .select({ id: sessionTable.id })
      .from(sessionTable)
      .where(and(eq(sessionTable.userId, personId), lte(sessionTable.expiresAt, new Date(now))))
    yield* database.run(
      database
        .delete(pushTargets)
        .where(
          and(eq(pushTargets.personId, personId), sql`${pushTargets.sessionId} in (${expired})`),
        ),
    )
    const rows = yield* database.run(
      database
        .select({ target: pushTargets })
        .from(pushTargets)
        .innerJoin(sessionTable, eq(sessionTable.id, pushTargets.sessionId))
        .where(
          and(
            eq(pushTargets.personId, personId),
            eq(sessionTable.userId, personId),
            gt(sessionTable.expiresAt, new Date(now)),
          ),
        ),
    )
    return yield* Effect.forEach(rows, ({ target }) => decodeTarget(target))
  })

  /** An address already belonging to someone else is concealed as a conflict, never transferred. */
  const register = Effect.fn('PushTargets.register')(function* (input: {
    readonly personId: PersonId
    readonly sessionId: SessionId
    readonly destination: PushDestination
  }) {
    yield* validateDestination(input.destination)
    const now = yield* Clock.currentTimeMillis
    const id = PushTargetId.make(NodeCrypto.randomUUID())
    const hash = addressHash(input.destination)
    const row = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const sessions = yield* tx
          .select({ id: sessionTable.id })
          .from(sessionTable)
          .where(
            and(
              eq(sessionTable.id, input.sessionId),
              eq(sessionTable.userId, input.personId),
              gt(sessionTable.expiresAt, new Date(now)),
            ),
          )
          .for('key share')
        if (sessions.length === 0)
          return yield* new Unauthenticated({ message: 'Sign in to register notifications.' })
        const inserted = yield* tx
          .insert(pushTargets)
          .values({
            id,
            personId: input.personId,
            sessionId: input.sessionId,
            destination: yield* encodeDestination(input.destination),
            addressHash: hash,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: pushTargets.addressHash,
            // Moving to a new session creates new authority. An old Expo ticket must not revoke it.
            set: {
              id: sql`case when ${pushTargets.sessionId} = ${input.sessionId} then ${pushTargets.id} else ${id} end`,
              createdAt: sql`case when ${pushTargets.sessionId} = ${input.sessionId} then ${pushTargets.createdAt} else ${now} end`,
              sessionId: input.sessionId,
              destination: yield* encodeDestination(input.destination),
            },
            setWhere: eq(pushTargets.personId, input.personId),
          })
          .returning()
        if (inserted.length === 0)
          return yield* new Conflict({ message: 'This push destination is already registered.' })
        return yield* returned(inserted, 'push target')
      }),
    )
    yield* changes.publish([Topic.person(input.personId)])
    const stored = yield* decodeTarget(row)
    return PushTarget.make({
      id: stored.id,
      destination: stored.destination,
      createdAt: stored.createdAt,
    })
  })

  /** Lists all of this Person's active targets across sessions; no Company can widen ownership. */
  const list = Effect.fn('PushTargets.list')(function* (personId: PersonId) {
    return (yield* active(personId)).map((row) =>
      PushTarget.make({ id: row.id, destination: row.destination, createdAt: row.createdAt }),
    )
  })

  /** A recipient may remove any of their own targets, from any of their sessions. */
  const remove = Effect.fn('PushTargets.remove')(function* (personId: PersonId, id: PushTargetId) {
    yield* database.run(
      database
        .delete(pushTargets)
        .where(and(eq(pushTargets.id, id), eq(pushTargets.personId, personId))),
    )
    yield* changes.publish([Topic.person(personId)])
  })
  return { active, register, list, remove }
}

export class PushTargets extends Context.Service<PushTargets, ReturnType<typeof makeTargets>>()(
  'vivid/PushTargets',
) {}

/** Session deletion cascades; the auth Person-topic publication refreshes WatchPushTargets. */
export const pushTargetsLayer = Layer.effect(
  PushTargets,
  Effect.gen(function* () {
    return PushTargets.of(makeTargets(yield* Database, yield* Changes))
  }),
)
