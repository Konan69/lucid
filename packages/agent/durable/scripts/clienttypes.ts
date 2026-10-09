import type { Metadata } from '@vivid/durable/client'
import type { UIMessage } from 'ai'

/** A client-only consumer must type metadata without resolving a server/Pi declaration. */
export function timings(message: UIMessage<Metadata>): Metadata['responses'] {
  if (message.metadata === undefined) return undefined
  return message.metadata.responses
}
