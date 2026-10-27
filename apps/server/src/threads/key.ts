import * as NodeCrypto from 'node:crypto'
import { RunId, type ThreadId } from '@vivid/contracts'

/** Product reservation identity is known before admission and never predicts a Pi submission. */
export const deliveryRunId = (threadId: ThreadId, key: string) =>
  RunId.make(
    `run_${NodeCrypto.createHash('sha256')
      .update(JSON.stringify([threadId, key]))
      .digest('hex')}`,
  )

/** A client's opaque key is scoped to its Person and cannot collide with producer keys. */
export const messageKey = (personId: import('@vivid/contracts').PersonId, key: string) =>
  `message-${NodeCrypto.createHash('sha256')
    .update(JSON.stringify([personId, key]))
    .digest('hex')}`
