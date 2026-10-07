import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { Effect, Option } from 'effect'

/** AI SDK owns part assembly; malformed internally produced chunks are defects, not Pi failures. */
export const readMessage = Effect.fn('Durable.readMessage')(function* (
  stream: ReadableStream<UIMessageChunk>,
) {
  const iterator = readUIMessageStream({ stream, terminateOnError: true })[Symbol.asyncIterator]()
  let completed = false
  // Match for-await cleanup: a failed or interrupted SDK pull releases its iterator in this scope.
  function closeForSdk() {
    if (completed || iterator.return === undefined) return Promise.resolve()
    return iterator.return().then(() => {})
  }
  yield* Effect.addFinalizer(() => Effect.promise(closeForSdk))
  let last = Option.none<UIMessage>()
  for (;;) {
    const next = yield* Effect.promise(() => iterator.next())
    if (next.done) {
      completed = true
      break
    }
    last = Option.some(next.value)
  }
  return Option.getOrThrow(last)
}, Effect.scoped)
