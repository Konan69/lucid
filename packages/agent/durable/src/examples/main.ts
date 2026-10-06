import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { Schema } from 'effect'

import { abort, answer, decide, history, holdId, respond, waiting } from '@vivid/durable'

const decodeDecision = Schema.decodeUnknownPromise(
  Schema.fromJsonString(
    Schema.Struct({
      holdId: Schema.String,
      approved: Schema.Boolean,
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
)
const decodeAnswer = Schema.decodeUnknownPromise(
  Schema.fromJsonString(
    Schema.Struct({
      holdId: Schema.String,
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
    const body = await decodeDecision(await request.text())
    const decision = { ...body, holdId: holdId(body.holdId) }
    return Response.json(await decide(harness, conversationId, decision, context))
  }
  if (path === '/answer') {
    const body = await decodeAnswer(await request.text())
    const output = { ...body, holdId: holdId(body.holdId) }
    const delivered = await answer(harness, conversationId, output, context)
    return Response.json(delivered)
  }
  return new Response(null, { status: 404 })
}
