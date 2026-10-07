import type { Context } from '@earendil-works/chord'
import type { Harness, ConversationId } from '@earendil-works/pi-durable'
import { readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from 'ai'
import { Array as Arr, Effect, Option, Schema, Stream } from 'effect'
import { waiting, type HoldId, type ConversationMissing, type PiFailed } from '../core.ts'

/** Decode opaque SDK reader/validator failures exactly once, at the fixture's SDK ingress. */
export class ReadFailed extends Schema.TaggedError<ReadFailed>()(
  'ReadFailed',
  { cause: Schema.Defect() },
  { title: 'ReadFailed' },
) {}
export type ReadResult = {
  readonly chunks: UIMessageChunk[]
  readonly types: UIMessageChunk['type'][]
  readonly message: UIMessage
}

/** The SDK owns folding and continuation state; an empty unseeded stream is a fixture failure. */
export const read = Effect.fn('Test.readMessage')(function* (
  stream: ReadableStream<UIMessageChunk>,
  from: Option.Option<UIMessage>,
): Effect.fn.Return<UIMessage, ReadFailed> {
  const options = Option.match(from, {
    onNone: () => ({ stream }),
    onSome: (message) => ({ stream, message }),
  })
  const messages = yield* Stream.runCollect(
    Stream.fromAsyncIterable(readUIMessageStream(options), (cause) => new ReadFailed({ cause })),
  )
  const message = Option.orElse(Arr.last(messages), () => from)
  if (Option.isNone(message))
    return yield* new ReadFailed({ cause: new Error('Expected an assistant message') })
  return message.value
})

/** Every emitted chunk crosses the installed SDK validator, even when its TypeScript type is trusted. */
const checked = Effect.fn('Test.checkedChunks')(function* (stream: ReadableStream<UIMessageChunk>) {
  const schema = uiMessageChunkSchema()
  if (schema.validate === undefined)
    return yield* new ReadFailed({ cause: new Error('Expected SDK chunk validator') })
  const validate = schema.validate.bind(schema)
  return yield* Stream.runCollect(
    Stream.fromReadableStream({
      evaluate: () => stream,
      onError: (cause) => new ReadFailed({ cause }),
    }).pipe(
      Stream.mapEffect((chunk) =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: () => Promise.resolve(validate(chunk)),
            catch: (cause) => new ReadFailed({ cause }),
          })
          if (!result.success) return yield* new ReadFailed({ cause: result.error })
          return result.value
        }),
      ),
    ),
  )
})

/** A live Web stream must fold concurrently with validation. Effect.all observes both branches'
 * failures and interrupts its sibling; no collecting Promise can reject without a consumer. */
export const consumeReadable = Effect.fn('Test.consumeReadable')(function* (
  stream: ReadableStream<UIMessageChunk>,
  from: Option.Option<UIMessage>,
): Effect.fn.Return<ReadResult, ReadFailed> {
  const [raw, folded] = stream.tee()
  const [chunks, message] = yield* Effect.all([checked(raw), read(folded, from)], {
    concurrency: 'unbounded',
  })
  return { chunks, types: chunks.map((chunk) => chunk.type), message }
})

/** Preserve the finite Effect stream's collect-then-fold ordering and its original typed failures. */
export const consume = Effect.fn('Test.consume')(function* <E, R>(
  stream: Stream.Stream<UIMessageChunk, E, R>,
  from: Option.Option<UIMessage>,
): Effect.fn.Return<ReadResult, E | ReadFailed, R> {
  const chunks = yield* Stream.runCollect(stream)
  const readable = yield* Stream.toReadableStreamEffect(Stream.fromIterable(chunks))
  return yield* consumeReadable(readable, from)
})

/** Resolve a real waiting task. A missing row has no HoldId, so report reader failure rather than
 * inventing one to construct CallNotWaiting (which requires the absent durable identity). */
export const hold = Effect.fn('Test.hold')(function* (
  harness: Harness,
  conversationId: ConversationId,
  callId: string,
  context: Context,
): Effect.fn.Return<HoldId, ConversationMissing | PiFailed | ReadFailed> {
  const rows = (yield* waiting(harness, conversationId, context)).filter(
    (row) => row.callId === callId,
  )
  const row = rows[0]
  if (rows.length !== 1 || row === undefined)
    return yield* new ReadFailed({ cause: new Error(`Expected one waiting ${callId}`) })
  return row.holdId
})
