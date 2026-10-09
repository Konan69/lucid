import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { respond, type RequestInput, type HoldId, type Metadata } from '@vivid/durable'
import {
  resumable,
  ConnectionLost,
  connectionLostInput,
  type Metadata as ClientMetadata,
} from '@vivid/durable/client'
import { DefaultChatTransport, type ChatTransport, type UIMessage } from 'ai'
import * as Core from '@vivid/durable/core'
import { Schema, type Types } from 'effect'

const request: RequestInput = new Request('https://durable.test/chat', { method: 'POST' })

/** Promise consumers must see the public Request ingress and Response result in the tarball. */
export function promiseTurn(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<Response> {
  return respond(harness, conversationId, request, context)
}

/** Effect consumers resolve the same public contracts through the core entry. */
export const effectTurn = Core.respond
/** Hold identity crosses entries without losing its public brand. */
export const identity: HoldId = Schema.decodeUnknownSync(Core.HoldId)('hold:1')

/** Browser/React Native entry resolves the SDK transport without importing the core. */
export const transport: ChatTransport<UIMessage> = resumable(new DefaultChatTransport())
export const interruption: Error = new ConnectionLost({ cause: connectionLostInput })

/** The packed client, Promise and Effect entries share one exact wire vocabulary. */
export const clientMetadataMatches: Types.Equals<ClientMetadata, Metadata> = true
export const coreMetadataMatches: Types.Equals<ClientMetadata, Core.Metadata> = true

/** The optional storage entry stays resolvable when its pg peer is installed by the host. */
export { openPgStorage } from '@vivid/durable/postgres'

/** A published host reads both entries' identical metadata types on an SDK message. */
export function models(message: UIMessage<Metadata>): Core.Metadata['models'] {
  if (message.metadata === undefined) return []
  return message.metadata.models
}
