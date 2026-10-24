import { inArray } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import type { ThreadId } from '@vivid/contracts'
import type { Database } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

/**
 * Stage writes announce the Thread owner's Feed on the same transaction as the write. In a shared
 * Conversation the acting Person or an ask's addressee may differ from its owner; neither changes
 * whose Feed contains the Thread. Both Thread places count, regardless of notification policy.
 */
export const announceFeed = Effect.fn('Feed.announce')(function* (
  tx: Transaction,
  ids: ReadonlyArray<ThreadId>,
) {
  if (ids.length === 0) return
  const owners = yield* tx
    .selectDistinct({ person: threads.personId })
    .from(threads)
    .where(inArray(threads.id, [...ids]))
  yield* announce(
    tx,
    owners.map(({ person }) => Topic.part('feed')(Topic.person(person))),
  )
})
