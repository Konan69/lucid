import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import type { PersonId } from '@vivid/contracts'
import { Database } from '../../database/client.ts'
import { settingsTable } from '../../settings/tables.ts'

/**
 * Whether this Person has turned egress on (`Settings.egress`, off until they do).
 *
 * This is the one place the server asks. Both things that act on the choice read it here: the
 * browser step that may start the Computer's browser (`store.ts`, `browse`), and the relay that
 * joins the Person's desktop app to their Computer (`relay.ts`). Issue 61 removes the choice:
 * this then answers `true` for everyone, or is deleted with its two callers' conditions.
 *
 * A Person whose settings were never written has changed nothing, so the answer is "off".
 */
export const egressChosen = Effect.fn('Egress.chosen')(function* (person: PersonId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ egress: settingsTable.egress })
      .from(settingsTable)
      .where(eq(settingsTable.personId, person))
      .limit(1),
  )
  return rows.some((row) => row.egress)
})
