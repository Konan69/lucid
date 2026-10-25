import * as NodeCrypto from 'node:crypto'
import { RunId, type PersonId, type ThreadId } from '@vivid/contracts'

/** Product reservation identity is known before admission and never predicts a Pi submission. */
export const deliveryRunId = (threadId: ThreadId, key: string) =>
  RunId.make(
    `run_${NodeCrypto.createHash('sha256')
      .update(JSON.stringify([threadId, key]))
      .digest('hex')}`,
  )

/** Client keys are confined to their Person and cannot collide with product signal keys. */
export const messageKey = (personId: PersonId, key: string) =>
  `message-${NodeCrypto.createHash('sha256')
    .update(JSON.stringify([personId, key]))
    .digest('hex')}`
