import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { Schema } from 'effect'

import { HoldId } from '@vivid/durable/core'
import { abort, answer, decide, history, respond, waiting } from '@vivid/durable'

const decodeDecision = Schema.decodeUnknownPromise(
  Schema.fromJsonString(
    Schema.Struct({
      holdId: HoldId,
      approved: Schema.Boolean,
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
)
const decodeAnswer = Schema.decodeUnknownPromise(
  Schema.fromJsonString(
    Schema.Struct({
      holdId: HoldId,
      output: Schema.MutableJson,
    }),
  ),
)

/**
 * The host authorizes this conversation before calling the handler. Its HTTP framework maps schema
 * rejections to 400 and records other failures; no invalid payload reaches a durable decision.
 * Paths are relative to the host's conversation route. Chat POST/GET use the stock SDK protocol.
 */
export async function route(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/chat') return respond(harness, conversationId, request, context)
  if (path === '/history' && request.method === 'GET')
    return Response.json(await history(harness, conversationId, { limit: 50 }, context))
  if (path === '/waiting' && request.method === 'GET')
    return Response.json(await waiting(harness, conversationId, context))
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  if (path === '/abort') {
    await abort(harness, conversationId, context)
    return new Response(null, { status: 204 })
  }
  if (path === '/decide') {
    const decision = await decodeDecision(await request.text())
    return Response.json(await decide(harness, conversationId, decision, context))
  }
  if (path === '/answer') {
    const output = await decodeAnswer(await request.text())
    const delivered = await answer(harness, conversationId, output, context)
    if (delivered === undefined) return new Response(null, { status: 204 })
    return Response.json(delivered)
  }
  return new Response(null, { status: 404 })
}
