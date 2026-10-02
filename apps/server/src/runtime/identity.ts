import * as NodeCrypto from 'node:crypto'
import { RunId, type ThreadId } from '@vivid/contracts'

/**
 * Flue 2.1's frozen keyed-submission wire format (installed runtime errors module). There is no
 * public reservation/helper API. Reproducing this format lets the server persist authority before
 * admission; the receipt is checked against it, so a future SDK incompatibility fails visibly.
 */
export const submissionId = (threadId: ThreadId, key: string): RunId =>
  RunId.make(
    `sub_ik_${NodeCrypto.createHash('sha256').update(`flue-submission-key\nvivid\n${threadId}\n${key}`).digest('hex').slice(0, 32)}`,
  )
