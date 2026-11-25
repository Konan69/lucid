import * as NodeCrypto from 'node:crypto'
import { RunId, type ThreadId } from '@vivid/contracts'

/** Product ids retain main's keyed identity so historical answer and producer retries join their
 * stored Runs. This frozen hash is product identity only; Pi allocates a separate submission number. */
export const deliveryRunId = (threadId: ThreadId, key: string) =>
  RunId.make(
    `sub_ik_${NodeCrypto.createHash('sha256').update(`flue-submission-key\nvivid\n${threadId}\n${key}`).digest('hex').slice(0, 32)}`,
  )

/** A client's opaque key is scoped to its Person and cannot collide with producer keys. */
export const messageKey = (personId: import('@vivid/contracts').PersonId, key: string) =>
  `message-${NodeCrypto.createHash('sha256')
    .update(JSON.stringify([personId, key]))
    .digest('hex')}`
