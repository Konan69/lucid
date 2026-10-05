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
