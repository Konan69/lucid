import { and, eq, inArray } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import {
  DatabaseFailure,
  Thread,
  ThreadAudience,
  type PersonId,
  type PersonSummary,
  type ThreadAttention,
  type ThreadId,
} from '@vivid/contracts'
import { approvals } from '../approvals/tables.ts'
import { loadSummaries } from '../auth/access.ts'
import { Database } from '../database/client.ts'
import { inputRequests } from '../inputs/tables.ts'
import type { StoredThread } from './access.ts'
import { runs, threadParticipants, threadReads } from './tables.ts'

type DatabaseService = Database['Service']

/** The Person a row names, who must exist: every reference is a foreign key that cascades. */
export const summaryFor = (summaries: ReadonlyMap<PersonId, PersonSummary>, id: PersonId) => {
  const summary = summaries.get(id)
  return summary === undefined
    ? Effect.fail(new DatabaseFailure({ message: 'A record names a Person who does not exist' }))
    : Effect.succeed(summary)
}

/**
 * What a Thread needs from one Person, most pressing first. A Run at work outranks what waits on
 * the Person: Vivid keeps working after it asks (`ask_person`), so a Thread with a question open
 * and a Run going is working, and its question shows in its banner. Ranking the question first
 * showed a working Thread as stopped, the defect T3 Code fixed for Codex's async questions
 * (pingdotgg/t3code#15258, "Async questions make a running thread show as Awaiting Input").
 */
const attentionOf = (input: {
  readonly needsYou: boolean
  readonly working: boolean
  readonly unread: boolean
}): ThreadAttention => {
  if (input.working) return 'Working'
  if (input.needsYou) return 'NeedsYou'
  return input.unread ? 'Unread' : 'Quiet'
}

/**
 * The ids of the Threads, among these, that have something waiting on this Person: a pending
 * Approval or an unanswered question addressed to them.
 *
 * This reads two other domains' tables for one yes-or-no per Thread. The Approvals and Input
 * requests themselves are only ever built by their own stores.
 */
const waitingOn = Effect.fn('Threads.waitingOn')(function* (
  database: DatabaseService,
  ids: ReadonlyArray<ThreadId>,
  personId: PersonId,
) {
  const asked = yield* database.run(
    database
      .selectDistinct({ threadId: approvals.threadId })
      .from(approvals)
      .where(
        and(
          inArray(approvals.threadId, ids),
          eq(approvals.personId, personId),
          eq(approvals.status, 'pending'),
        ),
      ),
  )
  const questions = yield* database.run(
    database
      .selectDistinct({ threadId: inputRequests.threadId })
      .from(inputRequests)
      .where(
        and(
          inArray(inputRequests.threadId, ids),
          eq(inputRequests.personId, personId),
          eq(inputRequests.status, 'waiting'),
        ),
      ),
  )
  return new Set<string>([...asked, ...questions].map((row) => row.threadId))
})

/** Everything beside a list of Threads that their wire form is drawn from, loaded once. */
const beside = Effect.fn('Threads.beside')(function* (
  database: DatabaseService,
  rows: ReadonlyArray<StoredThread>,
  personId: PersonId,
) {
  const ids = rows.map((row) => row.id)
  const members = yield* database.run(
    database.select().from(threadParticipants).where(inArray(threadParticipants.threadId, ids)),
  )
  const reads = yield* database.run(
    database
      .select()
      .from(threadReads)
      .where(and(inArray(threadReads.threadId, ids), eq(threadReads.personId, personId))),
  )
  const working = yield* database.run(
    database
      .selectDistinct({ threadId: runs.threadId })
      .from(runs)
      .where(and(inArray(runs.threadId, ids), eq(runs.state, 'working'))),
  )
  const summaries = yield* loadSummaries([
    ...rows.map((row) => row.personId),
    ...members.map((member) => member.personId),
  ]).pipe(Effect.provideService(Database, database))
  return {
    summaries,
    members,
    readAt: new Map(reads.map((read) => [read.threadId, read.readAt] as const)),
    working: new Set<string>(working.map((row) => row.threadId)),
    needsYou: yield* waitingOn(database, ids, personId),
  }
})

type Beside = Effect.Success<ReturnType<typeof beside>>

/** A Thread's audience as the wire union, with the faces of the People it is shared with. */
const audienceOf = Effect.fn('Threads.audienceOf')(function* (row: StoredThread, around: Beside) {
  if (row.audience === 'private') return ThreadAudience.cases.Private.make({})
  if (row.audience === 'company') return ThreadAudience.cases.Company.make({})
  const participants = yield* Effect.forEach(
    around.members.filter((member) => member.threadId === row.id),
    (member) => summaryFor(around.summaries, member.personId),
  )
  return ThreadAudience.cases.People.make({ participants })
})

const oneThread = Effect.fn('Threads.oneThread')(function* (row: StoredThread, around: Beside) {
  const readAt = around.readAt.get(row.id)
  return Thread.make({
    id: row.id,
    title: row.title,
    preview: row.preview,
    updatedAt: row.updatedAt,
    archived: row.archived,
    createdBy: yield* summaryFor(around.summaries, row.personId),
    audience: yield* audienceOf(row, around),
    projectId: row.projectId,
    attention: attentionOf({
      needsYou: around.needsYou.has(row.id),
      working: around.working.has(row.id),
      unread: readAt === undefined || readAt < row.updatedAt,
    }),
  })
})

/**
 * Stored Threads as one Person sees them. Attention is computed here and nowhere stored: it is a
 * fact about a Thread and a Person together (what is waiting on them, what they have not seen),
 * so two People looking at the same shared Thread rightly get different answers.
 */
export const toWire = Effect.fn('Threads.toWire')(function* (
  database: DatabaseService,
  rows: ReadonlyArray<StoredThread>,
  personId: PersonId,
) {
  if (rows.length === 0) return []
  const around = yield* beside(database, rows, personId)
  return yield* Effect.forEach(rows, (row) => oneThread(row, around))
})
