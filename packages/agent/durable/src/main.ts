import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai'
import { Effect, Option, Schema, Stream } from 'effect'

import * as Core from './core.ts'
import { TurnInvalid } from './errors.ts'
import { prepareRun } from './stream.ts'
import { TurnBody } from './respond.ts'
import type { ToolsOptions } from './tools.ts'

/** Like runtime/client.test.ts decodeIncoming, parse JSON text and validate through one compiled codec. */
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(TurnBody))

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

/** HTTP ingress reads body text once, parses and decodes the latest turn, and maps only the two chat protocol failures. */
export const respond = (
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => request.text(),
      catch: () => new TurnInvalid({}),
    }).pipe(
      Effect.flatMap(decodeRequest),
      Effect.mapError(() => new TurnInvalid({})),
      Effect.flatMap((turn) => Core.respond(harness, conversationId, turn, context)),
      Effect.flatMap((stream) => Stream.toReadableStreamEffect(stream)),
      Effect.map((stream) => createUIMessageStreamResponse({ stream })),
      Effect.catchTag('TurnInvalid', () =>
        Effect.succeed(
          new Response('Expected a user message or a message with tool calls', { status: 400 }),
        ),
      ),
      Effect.catchTag('RunMissing', () =>
        Effect.succeed(new Response('No run made these tool calls', { status: 409 })),
      ),
    ),
  )

export {
  ConversationMissing,
  PiFailed,
  TurnInvalid,
  RunMissing,
  ToolSchemaFailed,
  ToolFailed,
  ToolOutputFailed,
} from './errors.ts'
export type { Answer, Decision, Settlement, Plan, Source } from './holds.ts'
export type { Waiting } from './waiting.ts'
export type { Replay, ToolsOptions } from './tools.ts'
export type { RunInput } from './stream.ts'
export type { RunState, Step, Chunk } from './chunks.ts'
export type { ChatTurn } from './respond.ts'
