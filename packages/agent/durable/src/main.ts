/** Runtime adapters spell out their public parameters so packed declarations remain readable.
 * Keep the compiled unknown-body decoder as a const ingress; every operation below exposes plain
 * Promise results, without forwarding an inferred Effect implementation signature. */
import type { Context } from '@earendil-works/chord'
import type { ConversationId, Extension, Harness } from '@earendil-works/pi-durable'
import {
  createUIMessageStreamResponse,
  type ToolSet,
  type ToolExecutionOptions,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { Effect, Function, Option, Result, Schema, Stream } from 'effect'

import * as Core from './core.ts'
import { HoldIdInvalid, TurnInvalid } from './errors.ts'
import type { Answer, Decision, Settlement } from './holds.ts'
import type { Waiting } from './waiting.ts'
import type { RunInput } from './stream.ts'
import type { ResumeInput } from './resume.ts'
import { prepareRun } from './stream.ts'
import { turnFailure, TurnBody, respondWithPolicy, type TurnInput } from './respond.ts'
import type { ToolsOptions as EffectToolsOptions, ToolScope } from './tools.ts'
import { httpStream } from './http.ts'
import { inputPolicy, type InputOptions } from './input.ts'

export type { Metadata } from './metadata.ts'

/** A host can bound decoded parts while preserving the four-argument Request ingress. */
export type RequestInput = Request | { readonly request: Request; readonly options: InputOptions }

/** Like runtime/client.test.ts decodeIncoming, parse JSON text and validate through one compiled codec. */
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(TurnBody))

/** Compile the object ingress once; reject the original tagged class at the Promise boundary. */
export const decodeTurn = Function.flow(Core.decodeTurn, (effect) => Effect.runPromise(effect))

/** Preserve the SDK ingress type; contextSchema supplies the tool's concrete runtime contract. */
export type ToolContext = ToolExecutionOptions<unknown>['context']

/** Promise hosts resolve per-call authority with a value or Promise; core hosts return an Effect. */
export type ToolsOptions<ContextValue = ToolContext> = Omit<EffectToolsOptions, 'context'> & {
  readonly context?: (scope: ToolScope) => ContextValue | PromiseLike<ContextValue>
}

/** Convert the resolver once at this Promise facade, before registering the shared Effect bridge. */
export const toolsExtension = <ContextValue = ToolContext>(
  name: string,
  tools: ToolSet,
  options: ToolsOptions<ContextValue> = {},
): Promise<Extension> => {
  const { context, ...settings } = options
  if (context === undefined) return Effect.runPromise(Core.toolsExtension(name, tools, settings))
  // Keep the unsafe callback in this classified Promise entry; core wraps its original failure once.
  const resolve = Effect.fn('Durable.resolvePromiseToolContext')(function* (scope: ToolScope) {
    return yield* Effect.tryPromise(async () => context(scope)).pipe(
      Effect.mapError((error) => error.cause),
    )
  })
  const resolved: EffectToolsOptions = { ...settings, context: resolve }
  return Effect.runPromise(Core.toolsExtension(name, tools, resolved))
}

/** Preserve the original tagged error classes at the Promise rejection boundary. */
export const decide = (
  harness: Harness,
  conversationId: ConversationId,
  decision: Decision,
  context: Context,
): Promise<Settlement> => Effect.runPromise(Core.decide(harness, conversationId, decision, context))

/** Person-supplied results use the same durable ordering and idempotency as the Effect API. */
export const answer = (
  harness: Harness,
  conversationId: ConversationId,
  given: Answer,
  context: Context,
): Promise<Settlement> => Effect.runPromise(Core.answer(harness, conversationId, given, context))

/** No waiting state is mirrored into the facade; it is derived by the core on every call. */
export const waiting = (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<Waiting[]> => Effect.runPromise(Core.waiting(harness, conversationId, context))

/** Stream consumption owns observation; the platform stream cancels only its consumer scope. */
export const streamRun = (
  harness: Harness,
  input: RunInput,
  context: Context,
): Promise<ReadableStream<UIMessageChunk>> =>
  Effect.runPromise(
    prepareRun(harness, input, context).pipe(
      Effect.flatMap((stream) => Stream.toReadableStreamEffect(stream)),
    ),
  )

export type Attached =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly stream: ReadableStream<UIMessageChunk> }

/** Convert core absence once, into the Promise API's explicit idle/running result. */
export const attachRun = (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<Attached> =>
  Effect.runPromise(
    Core.attachRun(harness, conversationId, context).pipe(
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
export const continueRun = (
  harness: Harness,
  conversationId: ConversationId,
  input: ResumeInput,
  context: Context,
): Promise<ReadableStream<UIMessageChunk>> =>
  Effect.runPromise(
    Core.continueRun(harness, conversationId, input, context).pipe(
      Effect.flatMap((stream) => Stream.toReadableStreamEffect(stream)),
    ),
  )

/** A host-admitted request is followed by its durable identity, with the core's already-open watch. */
export const followRun = (
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
  context: Context,
): Promise<ReadableStream<UIMessageChunk>> =>
  Effect.runPromise(
    Core.followRun(harness, conversationId, requestId, context).pipe(
      Effect.flatMap((stream) => Stream.toReadableStreamEffect(stream)),
    ),
  )

/** A decoded turn shares the core and maps chat failures. Stale run message ids settle nothing.
 * Client outputs match call ids, requiring provider uniqueness within one run; approvals are task-scoped. */
export const respondTurn = (
  harness: Harness,
  conversationId: ConversationId,
  turn: TurnInput,
  context: Context,
): Promise<Response> =>
  Effect.runPromise(turnResponse(Core.respond(harness, conversationId, turn, context)))

/** Both Request and decoded-turn adapters share exactly the same expected HTTP error mapping. */
function turnResponse(program: ReturnType<typeof Core.respond>) {
  return program.pipe(
    Effect.flatMap((stream) => Stream.toReadableStreamEffect(httpStream(stream))),
    Effect.map((stream) => createUIMessageStreamResponse({ stream })),
    Effect.catchTag('TurnWithdrawn', (error) =>
      Effect.succeed(new Response(error.message, { status: 409 })),
    ),
    Effect.catchTag('TurnConflict', (error) =>
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
    Effect.catchTag('PartUnsupported', () =>
      Effect.succeed(new Response('Unsupported file; use an inline base64 image', { status: 400 })),
    ),
    Effect.catchTag('PartTooLarge', () =>
      Effect.succeed(new Response('File part too large', { status: 413 })),
    ),
  )
}

/** Read JSON text once; failed reads/decodes are invalid turns. Resumes must name the current run
 * message to settle anything. Outputs require call-id uniqueness within that run; approvals do not. */
export async function respond(
  harness: Harness,
  conversationId: ConversationId,
  input: RequestInput,
  context: Context,
): Promise<Response> {
  const { request, options } = 'request' in input ? input : { request: input, options: {} }
  const policy = await Effect.runPromise(inputPolicy(options))
  // AI SDK HttpChatTransport.reconnectToStream sends a bodyless GET and treats 204 as idle.
  if (request.method === 'GET') {
    return Effect.runPromise(
      Core.attachRun(harness, conversationId, context).pipe(
        Effect.flatMap((attached) =>
          Option.match(attached, {
            onNone: () => Effect.succeed(new Response(null, { status: 204 })),
            onSome: (stream) =>
              Stream.toReadableStreamEffect(httpStream(stream)).pipe(
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
    }).pipe(Effect.flatMap(decodeRequest), Effect.mapError(turnFailure), Effect.result),
  )
  if (Result.isFailure(turn)) return new Response(turn.failure.message, { status: 400 })
  return Effect.runPromise(
    turnResponse(
      respondWithPolicy(harness, conversationId, { turn: turn.success, policy }, context),
    ),
  )
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
  TurnRegenerate,
  TurnWithdrawn,
  TurnBusy,
  TurnConflict,
  BusyPolicyInvalid,
  PartUnsupported,
  PartTooLarge,
  LimitInvalid,
  RunMissing,
  ToolSchemaFailed,
  ToolFailed,
  ToolOutputFailed,
} from './errors.ts'
export type { Answer, Decision, Settlement, Plan, Source } from './holds.ts'
export type { Waiting } from './waiting.ts'
export type { Replay } from './tools.ts'
export type { RunInput } from './stream.ts'
export type { ResumeInput } from './resume.ts'
export type { RunState, Step, Chunk } from './chunks.ts'
export type { ChatTurn, TurnInput } from './respond.ts'
export type { InputPart, InputOptions } from './input.ts'

/** Explicit run cancellation is distinct from a fetch abort or a detached stream reader. */
export const abort = (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<void> => Effect.runPromise(Core.abort(harness, conversationId, context))

export type { HoldId } from './errors.ts'

export type HistoryPage = { readonly messages: UIMessage[]; readonly next?: string }
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

export { type ToolScope } from './tools.ts'
export {
  ToolContextFailed,
  ToolApprovalUnsupported,
  ToolApprovalContextUnavailable,
  ToolNameDuplicated,
  ToolApprovalFailed,
} from './errors.ts'
