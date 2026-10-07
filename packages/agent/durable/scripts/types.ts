import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { respond, type RequestInput, type HoldId } from '@vivid/durable'
import { resumption } from '@vivid/durable/client'
import type { ChatOnFinishCallback, PrepareReconnectToStreamRequest, UIMessage } from 'ai'
import * as Core from '@vivid/durable/core'
import { Schema } from 'effect'

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

/** Browser/React Native entry resolves both SDK callback types without importing the core. */
export const link: {
  prepare: PrepareReconnectToStreamRequest
  onFinish: ChatOnFinishCallback<UIMessage>
} = resumption()
