import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import { Effect, Function, Option, Result, Schema, Stream } from 'effect'

import * as Core from './core.ts'
import { HoldIdInvalid, TurnInvalid } from './errors.ts'
import { prepareRun } from './stream.ts'
import { TurnBody } from './respond.ts'
import type { ToolsOptions } from './tools.ts'
import type { InputOptions } from './input.ts'

/** A host can bound decoded parts while preserving the four-argument Request ingress. */
export type RequestInput = Request | { readonly request: Request; readonly options: InputOptions }

/** Like runtime/client.test.ts decodeIncoming, parse JSON text and validate through one compiled codec. */
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(TurnBody))

/** Compile the object ingress once; reject the original tagged class at the Promise boundary. */
export const decodeTurn = Function.flow(
  Core.decodeTurn,
  Effect.mapError(() => new TurnInvalid({})),
  (effect) => Effect.runPromise(effect),
)

/** Promise facade; tool registration has one Effect implementation. */
export const toolsExtension = (
  name: string,
  tools: Parameters<typeof Core.toolsExtension>[1],
  options: ToolsOptions = {},
) => Effect.runPromise(Core.toolsExtension(name, tools, options))

/** Preserve the original tagged error classes at the Promise rejection boundary. */
export const decide = (...args: Parameters<typeof Core.decide>) =>
  Effect.runPromise(Core.decide(...args))

/** Person-supplied results use the same durable ordering and idempotency as the Effect API. */
export const answer = (...args: Parameters<typeof Core.answer>) =>
  Effect.runPromise(Core.answer(...args))

/** No waiting state is mirrored into the facade; it is derived by the core on every call. */
export const waiting = (...args: Parameters<typeof Core.waiting>) =>
  Effect.runPromise(Core.waiting(...args))

/** Stream consumption owns observation; the platform stream cancels only its consumer scope. */
export const streamRun = (...args: Parameters<typeof Core.streamRun>) =>
  Effect.runPromise(
    prepareRun(...args).pipe(Effect.flatMap((stream) => Stream.toReadableStreamEffect(stream))),
  )

export type Attached =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly stream: ReadableStream<UIMessageChunk> }

/** Convert core absence once, into the Promise API's explicit idle/running result. */
export const attachRun = (...args: Parameters<typeof Core.attachRun>): Promise<Attached> =>
  Effect.runPromise(
    Core.attachRun(...args).pipe(
      Effect.flatMap((attached) =>
        Option.match(attached, {
          onNone: () => Effect.succeed<Attached>({ status: 'idle' }),
          onSome: (stream) =>
            Stream.toReadableStreamEffect(stream).pipe(
              Effect.map((readable): Attached => ({ status: 'running', stream: readable })),
            ),
        }),
      ),
    ),
  )

/** RunMissing rejects before a platform stream is returned. */
export const continueRun = (...args: Parameters<typeof Core.continueRun>) =>
  Effect.runPromise(
    Core.continueRun(...args).pipe(
      Effect.flatMap((stream) => Stream.toReadableStreamEffect(stream)),
    ),
  )

/** A decoded turn shares the core and maps chat failures. Stale run message ids settle nothing.
 * Client outputs match call ids, requiring provider uniqueness within one run; approvals are task-scoped. */
export const respondTurn = (
  harness: Harness,
  conversationId: ConversationId,
  turn: Core.TurnInput,
  context: Context,
): Promise<Response> =>
  Effect.runPromise(
    Core.respond(harness, conversationId, turn, context).pipe(
      Effect.flatMap((stream) => Stream.toReadableStreamEffect(stream)),
      Effect.map((stream) => createUIMessageStreamResponse({ stream })),
      Effect.catchTag('RunMissing', () =>
        Effect.succeed(new Response('No run made these tool calls', { status: 409 })),
      ),
      Effect.catchTag('ConversationMissing', () =>
        Effect.succeed(new Response('Conversation not found', { status: 404 })),
      ),
      Effect.catchTag('PartUnsupported', () =>
        Effect.succeed(
          new Response('Unsupported file; use an inline base64 image', { status: 400 }),
        ),
      ),
      Effect.catchTag('PartTooLarge', () =>
        Effect.succeed(new Response('File part too large', { status: 413 })),
      ),
    ),
  )

/** Read JSON text once; failed reads/decodes are invalid turns. Resumes must name the current run
 * message to settle anything. Outputs require call-id uniqueness within that run; approvals do not. */
export async function respond(
  harness: Harness,
  conversationId: ConversationId,
  input: RequestInput,
  context: Context,
): Promise<Response> {
  const { request, options } = 'request' in input ? input : { request: input, options: {} }
  // AI SDK HttpChatTransport.reconnectToStream sends a bodyless GET and treats 204 as idle.
  if (request.method === 'GET') {
    return Effect.runPromise(
      Core.attachRun(harness, conversationId, context).pipe(
        Effect.flatMap((attached) =>
          Option.match(attached, {
            onNone: () => Effect.succeed(new Response(null, { status: 204 })),
            onSome: (stream) =>
              Stream.toReadableStreamEffect(stream).pipe(
                Effect.map((readable) => createUIMessageStreamResponse({ stream: readable })),
              ),
          }),
        ),
        Effect.catchTag('ConversationMissing', () =>
          Effect.succeed(new Response('Conversation not found', { status: 404 })),
        ),
      ),
    )
  }
  if (request.method !== 'POST')
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } })
  const turn = await Effect.runPromise(
    Effect.tryPromise({
      try: () => request.text(),
      catch: () => new TurnInvalid({}),
    }).pipe(
      Effect.flatMap(decodeRequest),
      Effect.mapError(() => new TurnInvalid({})),
      Effect.option,
    ),
  )
  if (Option.isNone(turn))
    return new Response('Expected a user message or a message with tool calls', { status: 400 })
  return respondTurn(harness, conversationId, { turn: turn.value, options }, context)
}

export {
  HistoryCursorInvalid,
  HistoryPageInvalid,
  HoldIdInvalid,
  CallNotWaiting,
  WatchClosed,
  WatchOverflowed,
  ConversationMissing,
  PiFailed,
  TurnInvalid,
  PartUnsupported,
  PartTooLarge,
  RunMissing,
  ToolSchemaFailed,
  ToolFailed,
  ToolOutputFailed,
} from './errors.ts'
export type { Answer, Decision, Settlement, Plan, Source } from './holds.ts'
export type { Waiting } from './waiting.ts'
export type { Replay, ToolsOptions } from './tools.ts'
export type { RunInput } from './stream.ts'
export type { ResumeInput } from './resume.ts'
export type { RunState, Step, Chunk } from './chunks.ts'
export type { ChatTurn, TurnInput } from './respond.ts'
export type { InputPart, InputOptions } from './input.ts'

/** Explicit run cancellation is distinct from a fetch abort or a detached stream reader. */
export const abort = (...args: Parameters<typeof Core.abort>) =>
  Effect.runPromise(Core.abort(...args))

export type { HoldId } from './errors.ts'

export type HistoryPage = { readonly messages: import('ai').UIMessage[]; readonly next?: string }
export type HistoryRequest = { readonly limit: number; readonly before?: string }
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Core.HistoryCursor))
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Core.HistoryCursor), {
  onExcessProperty: 'error',
})

/**
 * The Promise wire uses opaque cursors. Active users preceding the first assistant entry remain
 * in history; GET reconnect supplies that assistant. Mid-run steers placed after assistant entries
 * stay out until settlement, because reconnect cannot insert them in order.
 */
export const history = (
  harness: Harness,
  conversationId: ConversationId,
  page: HistoryRequest,
  context: Context,
): Promise<HistoryPage> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const before =
        page.before === undefined
          ? Option.none<Core.HistoryCursor>()
          : Option.some(
              yield* decodeCursor(page.before).pipe(
                Effect.mapError(() => new Core.HistoryCursorInvalid({ conversationId })),
              ),
            )
      const result = yield* Core.history(
        harness,
        conversationId,
        { limit: page.limit, before },
        context,
      )
      const messages = [...result.messages]
      return Option.match(result.next, {
        onNone: (): HistoryPage => ({ messages }),
        onSome: (next): HistoryPage => ({ messages, next: encodeCursor(next) }),
      })
    }),
  )

const decodeHoldId = Schema.decodeUnknownResult(Core.HoldId)
/** Promise consumers validate their own opaque wire identity without importing the Effect contract. */
export function holdId(text: string): Core.HoldId {
  const result = decodeHoldId(text)
  if (Result.isFailure(result)) throw new HoldIdInvalid({})
  return result.success
}
