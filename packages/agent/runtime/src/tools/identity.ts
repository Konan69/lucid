import * as NodeCrypto from 'node:crypto'
import type { ThreadId } from '@vivid/contracts'
/** Stable ids make Flue durable-step retries idempotent at the server insert boundary. */
export function operationId(threadId: ThreadId, toolCallId: string, purpose: 'task' | 'follow-up') {
  const hex = NodeCrypto.createHash('sha256')
    .update(`${threadId}:${toolCallId}:${purpose}`)
    .digest('hex')
    .slice(0, 32)
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`
}
