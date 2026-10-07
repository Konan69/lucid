import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import { Effect, Match, Option, Schema, Stream } from 'effect'

import * as Durable from '@vivid/durable/core'
import { turnFailure } from '../respond.ts'

const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Durable.HistoryCursor))
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Durable.TurnBody))
const decodeLimit = Schema.decodeUnknownEffect(Schema.NumberFromString)
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Durable.HistoryCursor), {
  onExcessProperty: 'error',
})
const decodeDecision = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      holdId: Durable.HoldId,
      approved: Schema.Boolean,
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
)
const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ holdId: Durable.HoldId, output: Schema.MutableJson })),
)

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
  const turn = yield* decodeRequest(body).pipe(Effect.mapError(turnFailure))
  // Host policy, not a library default; middleware also bounds the raw request before reading.
  const stream = yield* Durable.respond(
    harness,
    conversationId,
    {
      turn,
      options: { maxPartBytes: 5 * 1024 * 1024 },
    },
    context,
  )
  // Admission failures precede headers; later watch failures use the SDK's error chunk.
  const observed = stream.pipe(
    Stream.catch((error) =>
      Stream.succeed<UIMessageChunk>({ type: 'error', errorText: error.message }),
    ),
  )
  return createUIMessageStreamResponse({ stream: yield* Stream.toReadableStreamEffect(observed) })
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
    Effect.catchTag('TurnRegenerate', (error) =>
      Effect.succeed(new Response(error.message, { status: 400 })),
    ),
    Effect.catchTag('TurnInvalid', (error) =>
      Effect.succeed(new Response(error.message, { status: 400 })),
    ),
    Effect.catchTag('PartUnsupported', () =>
      Effect.succeed(new Response('Unsupported file; use an inline base64 image', { status: 400 })),
    ),
    Effect.catchTag('PartTooLarge', () =>
      Effect.succeed(new Response('File part too large', { status: 413 })),
    ),
    Effect.catchTag('TurnWithdrawn', (error) =>
      Effect.succeed(new Response(error.message, { status: 409 })),
    ),
    Effect.catchTag('TurnBusy', (error) =>
      Effect.succeed(new Response(error.message, { status: 409 })),
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
  request: Request,
  context: Context,
) {
  const query = new URL(request.url).searchParams
  const limitText = query.get('limit')
  const limit =
    limitText === null
      ? 50
      : yield* decodeLimit(limitText).pipe(
          Effect.mapError(() => new Durable.HistoryPageInvalid({ conversationId })),
        )
  const beforeText = query.get('before')
  const before =
    beforeText === null
      ? Option.none<Durable.HistoryCursor>()
      : Option.some(
          yield* decodeCursor(beforeText).pipe(
            Effect.mapError(() => new Durable.HistoryCursorInvalid({ conversationId })),
          ),
        )
  const result = yield* Durable.history(harness, conversationId, { limit, before }, context)
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

/** All expected route failures are explicit; Pi adapter failures stay in the host's error channel. */
export const route = Effect.fn('Example.route')(
  function* (harness: Harness, conversationId: ConversationId, request: Request, context: Context) {
    const path = new URL(request.url).pathname
    if (path === '/chat') return yield* chat(harness, conversationId, request, context)
    if (path === '/history' && request.method === 'GET')
      return yield* history(harness, conversationId, request, context)
    if (path === '/waiting' && request.method === 'GET')
      return Response.json(yield* Durable.waiting(harness, conversationId, context))
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    if (path === '/abort') {
      yield* Durable.abort(harness, conversationId, context)
      return new Response(null, { status: 204 })
    }
    if (path === '/decide')
      return Response.json(
        yield* Durable.decide(
          harness,
          conversationId,
          yield* decodeDecision(yield* readBody(request)),
          context,
        ),
      )
    if (path === '/answer')
      return Response.json(
        yield* Durable.answer(
          harness,
          conversationId,
          yield* decodeAnswer(yield* readBody(request)),
          context,
        ),
      )
    return new Response(null, { status: 404 })
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        SchemaError: (error) => Effect.succeed(new Response(error.message, { status: 400 })),
        TurnInvalid: (error) => Effect.succeed(new Response(error.message, { status: 400 })),
        HistoryPageInvalid: (error) => Effect.succeed(new Response(error.message, { status: 400 })),
        HistoryCursorInvalid: (error) =>
          Effect.succeed(new Response(error.message, { status: 400 })),
        CallNotWaiting: (error) => Effect.succeed(new Response(error.message, { status: 409 })),
        ConversationMissing: (error) =>
          Effect.succeed(new Response(error.message, { status: 404 })),
      }),
    ),
)
