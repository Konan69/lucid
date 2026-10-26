import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import type { PersonId, PersonName } from '@vivid/contracts'
import { personTable } from './tables.ts'
import { Database, returned } from '../database/client.ts'

/**
 * Gives a Person the name they chose in Settings.
 *
 * The name is the Better Auth user's own `name` column, not a copy beside it: sign-in, every
 * Message's author, the People list and Vivid's prompt all read that one column (`findPerson`,
 * `loadSummaries`), so one write moves all of them. Signing in with Google again does not put the
 * provider's name back: Better Auth only overwrites it with `overrideUserInfoOnSignIn`, which
 * `auth/provider.ts` leaves off. It is written here rather than through
 * Better Auth's `updateUser` because that endpoint needs the request's cookie, and an RPC handler
 * has the Person, not the request. Better Auth keeps no copy of the name in its session cookie
 * here (no `cookieCache`), so nothing is left holding the old one.
 *
 * A Person who no longer exists has no row to return, which is a database fault: the call that
 * reached here was authenticated as them a moment ago.
 */
export const renamePerson = Effect.fn('Auth.renamePerson')(function* (
  personId: PersonId,
  name: PersonName,
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.run(
    database
      .update(personTable)
      .set({ name, updatedAt: new Date(now) })
      .where(eq(personTable.id, personId))
      .returning({ id: personTable.id }),
  )
  yield* returned(rows, 'Person')
})
