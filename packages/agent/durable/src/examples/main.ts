import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { Effect, Schema } from 'effect'

import {
  abort,
  answer,
  decide,
  history,
  holdId,
  respond,
  waiting,
  CallNotWaiting,
  ConversationMissing,
  HistoryCursorInvalid,
  HistoryPageInvalid,
  HoldIdInvalid,
  RunMissing,
  TurnWithdrawn,
  TurnBusy,
  TurnInvalid,
  PartUnsupported,
  PartTooLarge,
} from '@vivid/durable'

const decodeLimit = Schema.decodeUnknownPromise(Schema.NumberFromString)

/** The transport statuses group domain failures by what the caller can do next. */
const refusals = [
  { status: 413, errors: [PartTooLarge] },
  { status: 404, errors: [ConversationMissing] },
  { status: 409, errors: [CallNotWaiting, RunMissing, TurnWithdrawn, TurnBusy] },
  {
    status: 400,
    errors: [
      Schema.SchemaError,
      HoldIdInvalid,
      TurnInvalid,
      PartUnsupported,
      HistoryCursorInvalid,
      HistoryPageInvalid,
    ],
  },
] as const

/** Expected ingress/admission failures have transport meanings; unexpected failures still reject. */
function routeFailure(error: Error): Response {
  for (const refusal of refusals)
    if (refusal.errors.some((type) => error instanceof type))
      return new Response(error.message, { status: refusal.status })
  throw error
}

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
 * The host authorizes this conversation before calling the handler. Expected invalid inputs are
 * 400, stale interactions are 409 and missing conversations are 404; other failures still reject.
 * Paths are relative to the host's conversation route. Chat POST/GET use the stock SDK protocol.
 */
export function route(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  return dispatch(harness, conversationId, request, context).catch(routeFailure)
}

/** The framework's Promise-only ingress owns body/query reads and delegates durable work. */
async function dispatch(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  // Example host policy only. Bound raw request bytes in middleware before this route as well.
  if (path === '/chat')
    return respond(
      harness,
      conversationId,
      {
        request,
        options: { maxPartBytes: 5 * 1024 * 1024 },
      },
      context,
    )
  if (path === '/history' && request.method === 'GET') {
    const text = url.searchParams.get('limit')
    const limit = text === null ? 50 : await decodeLimit(text)
    const before = url.searchParams.get('before')
    const page = before === null ? { limit } : { limit, before }
    return Response.json(await history(harness, conversationId, page, context))
  }
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

/** Node HTTP/CLI callbacks are Promise-only framework entry points. This runtime entry executes
 * one supplied program; resource ownership and expected error handling stay with the host. */
export function runForNode<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program)
}
