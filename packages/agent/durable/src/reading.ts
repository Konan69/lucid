import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { Effect, Option } from 'effect'

/** AI SDK owns part assembly; malformed internally produced chunks are defects, not Pi failures. */
export const readMessage = (stream: ReadableStream<UIMessageChunk>) =>
  Effect.promise(() => readForSdk(stream))

/** Narrow SDK async-iterator adapter; history always supplies start and finite finish chunks. */
async function readForSdk(stream: ReadableStream<UIMessageChunk>): Promise<UIMessage> {
  let last = Option.none<UIMessage>()
  for await (const message of readUIMessageStream({ stream, terminateOnError: true }))
    last = Option.some(message)
  return Option.getOrThrow(last)
}
