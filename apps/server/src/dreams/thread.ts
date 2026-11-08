import * as NodeCrypto from 'node:crypto'
import { ThreadId, type DreamKey, type PersonId } from '@vivid/contracts'

/** The prefix of every Dreamer Thread. Reserved: a client cannot create one (`threads/store.ts`). */
const PREFIX = 'dream-'

/**
 * The Background Thread one Dreamer run reads in, derived from the Person and the cell's name for
 * the run, so asking again opens the same Thread. Hashed, so one Person's key never names another's.
 */
export const dreamThread = (person: PersonId, key: DreamKey) =>
  ThreadId.make(
    `${PREFIX}${NodeCrypto.createHash('sha256').update(`${person}\n${key}`).digest('hex').slice(0, 32)}`,
  )

/**
 * Whether Vivid is working in a Dreamer Thread. Only the server mints these ids, so the prefix is
 * proof: the Dreamer reads every Integration and never writes, sends or deletes (docs/28,
 * section 5, decided 27 October 2026: "every integration, read-only").
 */
export const isDreamThread = (thread: ThreadId) => thread.startsWith(PREFIX)
