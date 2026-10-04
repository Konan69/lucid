import { and, eq } from 'drizzle-orm'
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
  updatedAt: Schema.Number,
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

/**
 * Whether a Person may read a Thread and send into it.
 *
 * A personal-space Thread is its creator's alone. A Company Thread needs a current Membership in
 * that Company first, and then one of: the Thread is shared with the whole Company, the Person
 * created it, or the Person was added to it. A role is not a way in: an owner cannot read a
 * Member's private Thread (docs/22, rule 2).
 *
 * The Membership is read here, against the Thread's own Company, and not taken from the caller's
 * active workspace: a link opened from another workspace is judged by the same rule.
 */
export const canSee = Effect.fn('Threads.canSee')(function* (
  thread: StoredThread,
  personId: PersonId,
) {
  if (thread.companyId === null) return thread.personId === personId
  const database = yield* Database
  const memberships = yield* database.run(
    database
      .select({ id: membershipTable.id })
      .from(membershipTable)
      .where(
        and(eq(membershipTable.companyId, thread.companyId), eq(membershipTable.userId, personId)),
      )
      .limit(1),
  )
  if (memberships.length === 0) return false
  if (thread.audience === 'company' || thread.personId === personId) return true
  if (thread.audience === 'private') return false
  const participants = yield* database.run(
    database
      .select({ personId: threadParticipants.personId })
      .from(threadParticipants)
      .where(
        and(eq(threadParticipants.threadId, thread.id), eq(threadParticipants.personId, personId)),
      )
      .limit(1),
  )
  return participants.length > 0
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
  if (Option.isNone(thread) || !(yield* canSee(thread.value, personId))) {
    return yield* Effect.fail(new NotFound({ message: 'Thread not found' }))
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
