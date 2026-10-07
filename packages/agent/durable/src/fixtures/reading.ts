import type { Context } from '@earendil-works/chord'
import type { Harness, ConversationId } from '@earendil-works/pi-durable'
import { waiting } from '../core.ts'

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { Array as Arr, Effect, Option, Stream } from 'effect'

/** Use the real SDK reader after collecting the finite response, retaining every protocol chunk. */
export const consume = Effect.fn('Test.consume')(function* <E>(
  stream: Stream.Stream<UIMessageChunk, E>,
  from: Option.Option<UIMessage>,
) {
  const chunks = yield* Stream.runCollect(stream)
  const readable = yield* Stream.toReadableStreamEffect(Stream.fromIterable(chunks))
  const message = yield* read(readable, from)
  return { chunks, types: chunks.map((chunk) => chunk.type), message }
})

/** The SDK owns its async iterator; absence of an assistant message fails the test at this seam. */
export const read = Effect.fn('Test.readMessage')(function* (
  stream: ReadableStream<UIMessageChunk>,
  from: Option.Option<UIMessage>,
) {
  const options = Option.match(from, {
    onNone: () => ({ stream }),
    onSome: (message) => ({ stream, message }),
  })
  const messages = yield* Stream.runCollect(
    Stream.fromAsyncIterable(readUIMessageStream(options), (cause) => cause),
  )
  return Option.getOrThrow(Arr.last(messages))
})

/** Tests resolve a real waiting task; callers retain this id to repeat that exact interaction. */
export const hold = Effect.fn('Test.hold')(function* (
  harness: Harness,
  conversationId: ConversationId,
  callId: string,
  context: Context,
) {
  const rows = (yield* waiting(harness, conversationId, context)).filter(
    (row) => row.callId === callId,
  )
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`Expected one waiting ${callId}`)
  return rows[0].holdId
})
