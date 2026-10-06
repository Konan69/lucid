import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { createUIMessageStreamResponse } from 'ai'
import { Effect, Match, Option, Schema, Stream } from 'effect'

import * as Durable from '@vivid/durable/core'

const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Durable.HistoryCursor))
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Durable.TurnBody))

/** The only unsafe operation here reads the host Request; invalid/read-failed chat bodies are 400. */
const readBody = (request: Request) =>
  Effect.tryPromise({
    try: () => request.text(),
    catch: () => new Durable.TurnInvalid({}),
  })

/** Framework ingress reads once, then runs the same transport-neutral Effect program. */
const post = Effect.fn('Example.post')(function* (
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
) {
  const body = yield* readBody(request)
  const turn = yield* decodeRequest(body).pipe(Effect.mapError(() => new Durable.TurnInvalid({})))
  const stream = yield* Durable.respond(harness, conversationId, turn, context)
  return createUIMessageStreamResponse({ stream: yield* Stream.toReadableStreamEffect(stream) })
})

/** Reconnect returns 204 when idle, which the SDK interprets as no active stream. */
const get = Effect.fn('Example.get')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const attached = yield* Durable.attachRun(harness, conversationId, context)
  return yield* Option.match(attached, {
    onNone: () => Effect.succeed(new Response(null, { status: 204 })),
    onSome: (stream) =>
      Stream.toReadableStreamEffect(stream).pipe(
        Effect.map((readable) => createUIMessageStreamResponse({ stream: readable })),
      ),
  })
})

/** The host runs this Effect at its framework entry; authorization precedes durable access. */
export function chat(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
) {
  const response = Match.value(request.method).pipe(
    Match.when('POST', () => post(harness, conversationId, request, context)),
    Match.when('GET', () => get(harness, conversationId, context)),
    Match.orElse(() =>
      Effect.succeed(new Response(null, { status: 405, headers: { Allow: 'GET, POST' } })),
    ),
  )
  return response.pipe(
    Effect.catchTag('TurnInvalid', (error) =>
      Effect.succeed(new Response(error.message, { status: 400 })),
    ),
    Effect.catchTag('RunMissing', () =>
      Effect.succeed(new Response('No run made these tool calls', { status: 409 })),
    ),
    Effect.catchTag('ConversationMissing', () =>
      Effect.succeed(new Response('Conversation not found', { status: 404 })),
    ),
  )
}

/** A host's typed routes decode their bodies before passing task-scoped interactions here. */
export function actions(harness: Harness, conversationId: ConversationId, context: Context) {
  return {
    abort: () => Durable.abort(harness, conversationId, context),
    history: (page: Durable.HistoryRequest) =>
      Durable.history(harness, conversationId, page, context),
    waiting: () => Durable.waiting(harness, conversationId, context),
    decide: (decision: Durable.Decision) =>
      Durable.decide(harness, conversationId, decision, context),
    answer: (output: Durable.Answer) => Durable.answer(harness, conversationId, output, context),
  }
}

/** An authorized GET /history route serializes the core's opaque cursor with its schema. */
export const history = Effect.fn('Example.history')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const result = yield* Durable.history(
    harness,
    conversationId,
    { limit: 50, before: Option.none() },
    context,
  )
  const messages = [...result.messages]
  const body = Option.match(result.next, {
    onNone: () => ({ messages }),
    onSome: (next) => ({
      messages,
      next: encodeCursor(next),
    }),
  })
  return Response.json(body)
})
