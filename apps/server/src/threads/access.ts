import { and, eq, exists, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  CompanyId,
  NotFound,
  PersonId,
  ProjectId,
  ThreadId,
  type ThreadId as ThreadIdType,
} from '@vivid/contracts'
import { membershipTable } from '../companies/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { Topic } from '../live/changes.ts'
import { TitleSource } from './title.ts'
import { threadParticipants, threads } from './tables.ts'

/** How a Thread's audience is written in its row. */
export const StoredAudience = Schema.Literals(['private', 'people', 'company'] as const)
export type StoredAudience = typeof StoredAudience.Type

/** One Thread row, decoded. The wire `Thread` is built from this plus who is asking. */
export const StoredThread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  titleSource: TitleSource,
  preview: Schema.String,
  updatedAt: Schema.Finite,
  archived: Schema.Boolean,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  audience: StoredAudience,
  projectId: Schema.NullOr(ProjectId),
})
export interface StoredThread extends Schema.Schema.Type<typeof StoredThread> {}

export const decodeThread = decodeStored(StoredThread, 'Thread')

/** One Thread by id, with no opinion about who is asking. Callers decide access with `canSee`. */
export const findThread = Effect.fn('Threads.find')(function* (id: ThreadIdType) {
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(threads).where(eq(threads.id, id)).limit(1),
  )
  const row = rows[0]
  return row === undefined ? Option.none<StoredThread>() : Option.some(yield* decodeThread(row))
})

/** Only the named audience widens reach through participants; leftover rows never grant access. */
const beside = (personId: PersonId) =>
  ({
    private: sql`false`,
    people: exists(
      sql`(select 1 from ${threadParticipants} where ${threadParticipants.threadId} = ${threads.id} and ${threadParticipants.personId} = ${personId})`,
    ),
    company: sql`true`,
  }) satisfies { readonly [A in StoredAudience]: SQL }

/**
 * The reach rule over the Thread row in scope, for readers that decode the row afterwards.
 *
 * A personal-space Thread is its creator's alone. A Company Thread needs a current Membership in
 * that Company first, and then one of: the Thread is shared with the whole Company, the Person
 * created it, or the Person was added to it. A role is not a way in: an owner cannot read a
 * Member's private Thread (docs/22, rule 2).
 *
 * The Membership is read here, against the Thread's own Company, and not taken from the caller's
 * active workspace: a link opened from another workspace is judged by the same rule.
 * Keep creator reach on an invalid audience so ThreadStore.list still reports DatabaseFailure at
 * decode. StoredAudience.literals (rc.116 Schema.ts#Literals) drives every SQL comparison; beside's
 * exhaustive record forces any new audience to state its rule. Column chunks preserve Membership's
 * camelCase column names (Drizzle sql/sql.js#SQL.collectSQL).
 */
export const reachedBy = (personId: PersonId): SQL => {
  const member = exists(
    sql`(select 1 from ${membershipTable} where ${membershipTable.companyId} = ${threads.companyId} and ${membershipTable.userId} = ${personId})`,
  )
  const additions = beside(personId)
  const audiences = StoredAudience.literals.map(
    (audience) => sql`(${eq(threads.audience, audience)} and ${additions[audience]})`,
  )
  return sql`((${isNull(threads.companyId)} and ${eq(threads.personId, personId)}) or (${member} and (${eq(threads.personId, personId)} or (${sql.join(audiences, sql` or `)}))))`
}

/**
 * Fail closed when a reader never decodes the Thread row: corruption must not leak its notices.
 * Once audience is a database enum, remove this vocabulary guard and reachedBy's separate export.
 */
export const readableBy = (personId: PersonId): SQL =>
  sql`(${inArray(threads.audience, StoredAudience.literals)} and ${reachedBy(personId)})`

/** A nullable Thread reference grants nothing when absent, deleted, corrupt or outside current reach. */
export const readableThread = (thread: PgColumn, personId: PersonId): SQL =>
  exists(
    sql`(select 1 from ${threads} where ${threads.id} = ${thread} and ${readableBy(personId)})`,
  )

/** Whether requireThread would admit this Person now; absent and corrupt rows both return false. */
export const canSee = Effect.fn('Threads.canSee')(function* (id: ThreadIdType, personId: PersonId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ value: sql<number>`1` })
      .from(threads)
      .where(and(eq(threads.id, id), readableBy(personId)))
      .limit(1),
  )
  return rows.length > 0
})

/**
 * The Thread, for someone who may see it. A Thread the Person may not see is reported exactly like
 * one that does not exist, so an id cannot be probed.
 */
export const requireThread = Effect.fn('Threads.require')(function* (
  id: ThreadIdType,
  personId: PersonId,
) {
  const thread = yield* findThread(id)
  if (Option.isNone(thread) || !(yield* canSee(id, personId))) {
    return yield* new NotFound({ message: 'Thread not found' })
  }
  return thread.value
})

/**
 * Everyone whose screen shows this Thread: its creator, the People it is shared with, or the whole
 * Company. A write to a Thread is announced on these and not on the writer's own workspace, which
 * may be a different one (a Company Thread opened from a link while in a personal space).
 */
export const audienceTopics = (
  thread: StoredThread,
  participants: ReadonlyArray<PersonId>,
): ReadonlyArray<Topic> => {
  const here = [Topic.thread(thread.id), Topic.person(thread.personId)]
  if (thread.companyId !== null && thread.audience !== 'private') {
    // The Company topic covers a Thread that is, or just stopped being, everyone's or some
    // People's: lists across the Company re-run and each Person's result says what they may see.
    return [...here, Topic.company(thread.companyId), ...participants.map(Topic.person)]
  }
  return [...here, ...participants.map(Topic.person)]
}
