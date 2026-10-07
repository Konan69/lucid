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
  TurnWaiting,
  TurnBusy,
  TurnConflict,
  TurnInvalid,
  TurnRegenerate,
  PartUnsupported,
  PartTooLarge,
} from '@vivid/durable'

const decodeLimit = Schema.decodeUnknownPromise(Schema.FiniteFromString)

/** The transport statuses group domain failures by what the caller can do next. */
const refusals = [
  { status: 413, errors: [PartTooLarge] },
  { status: 404, errors: [ConversationMissing] },
  {
    status: 409,
    errors: [CallNotWaiting, RunMissing, TurnWithdrawn, TurnWaiting, TurnBusy, TurnConflict],
  },
  {
    status: 400,
    errors: [
      Schema.SchemaError,
      HoldIdInvalid,
      TurnInvalid,
      TurnRegenerate,
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
function dispatch(
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
    return (text === null ? Promise.resolve(50) : decodeLimit(text)).then((limit) => {
      const before = url.searchParams.get('before')
      const page = before === null ? { limit } : { limit, before }
      return history(harness, conversationId, page, context).then((result) => Response.json(result))
    })
  }
  if (path === '/waiting' && request.method === 'GET')
    return waiting(harness, conversationId, context).then((result) => Response.json(result))
  if (request.method !== 'POST')
    return Promise.resolve(new Response(null, { status: 405, headers: { Allow: 'POST' } }))
  if (path === '/abort')
    return abort(harness, conversationId, context).then(() => new Response(null, { status: 204 }))
  if (path === '/decide')
    return request
      .text()
      .then(decodeDecision)
      .then((body) =>
        decide(harness, conversationId, { ...body, holdId: holdId(body.holdId) }, context),
      )
      .then((result) => Response.json(result))
  if (path === '/answer')
    return request
      .text()
      .then(decodeAnswer)
      .then((body) =>
        answer(harness, conversationId, { ...body, holdId: holdId(body.holdId) }, context),
      )
      .then((result) => Response.json(result))
  return Promise.resolve(new Response(null, { status: 404 }))
}

/** Node HTTP/CLI callbacks are Promise-only framework entry points. This runtime entry executes
 * one supplied program; resource ownership and expected error handling stay with the host. */
export function runForNode<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program)
}
