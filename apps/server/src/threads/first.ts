import * as NodeCrypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Clock, Effect } from 'effect'
import { OpenFirstThreadResult, ThreadId, type PersonId } from '@vivid/contracts'
import { companyColumnOf, type Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database, returned } from '../database/client.ts'
import { firstThreads, runs, threads } from './tables.ts'

/**
 * Serialize first arrival on the existing Person row, across workspaces and server processes.
 * The Person primary key on the receipt is the final uniqueness constraint. Thread and receipt
 * commit together; Flue admission happens afterward through Conversation, outside SQL locks.
 * Look up the receipt before older Threads so the Thread we created remains an Existing result.
 */
export const claimFirstThread = Effect.fn('Threads.claimFirst')(function* (actor: Actor) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const personId = actor.person.id
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* returned(
        yield* tx
          .select({ id: personTable.id })
          .from(personTable)
          .where(eq(personTable.id, personId))
          .for('update'),
        'Person opening their first Thread',
      )
      const [recorded] = yield* tx
        .select()
        .from(firstThreads)
        .where(eq(firstThreads.personId, personId))
      if (recorded !== undefined)
        return OpenFirstThreadResult.cases.Existing.make({ thread: recorded.threadId })
      const earlier = yield* tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.personId, personId))
        .limit(1)
      if (earlier.length > 0) return OpenFirstThreadResult.cases.NotFirst.make({})
      const thread = ThreadId.make(NodeCrypto.randomUUID())
      yield* tx.insert(threads).values({
        id: thread,
        // The existing empty-Thread convention is "New thread": web data/threads.openThread
        // and mobile data/threads.UNTITLED use it before Person words supply a derived title.
        title: 'New thread',
        personId,
        companyId: companyColumnOf(actor.workspace),
        updatedAt: now,
      })
      yield* tx.insert(firstThreads).values({ personId, threadId: thread })
      return OpenFirstThreadResult.cases.Opened.make({ thread })
    }),
  )
})

/**
 * Undo only this Person's matching first-arrival receipt and its still-empty Thread. Lock the
 * Person before the Thread, matching first-arrival creation and RunStore.start respectively:
 * another arrival cannot claim midway, and another Run cannot insert after the emptiness check.
 * Any Run, including an unadmitted failed reservation, protects the Thread from deletion.
 */
export const releaseFirstThread = Effect.fn('Threads.releaseFirst')(function* (
  personId: PersonId,
  threadId: ThreadId,
) {
  const database = yield* Database
  yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx
        .select({ id: personTable.id })
        .from(personTable)
        .where(eq(personTable.id, personId))
        .for('update')
      const owned = yield* tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.personId, personId)))
        .for('update')
      if (owned.length === 0) return
      const recorded = yield* tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.threadId, threadId))
        .limit(1)
      if (recorded.length > 0) return
      const released = yield* tx
        .delete(firstThreads)
        .where(and(eq(firstThreads.personId, personId), eq(firstThreads.threadId, threadId)))
        .returning({ thread: firstThreads.threadId })
      if (released.length === 0) return
      yield* tx.delete(threads).where(eq(threads.id, threadId))
    }),
  )
})
