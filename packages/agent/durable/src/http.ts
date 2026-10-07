import type { UIMessageChunk } from 'ai'
import { Stream } from 'effect'

/** Once HTTP headers are sent, domain observation failures travel as the SDK error chunk. Admission
 * failures remain in the outer Effect so the host can choose their status before the first chunk. */
export function httpStream<E extends Error>(
  stream: Stream.Stream<UIMessageChunk, E>,
): Stream.Stream<UIMessageChunk> {
  return stream.pipe(
    Stream.catch((error) =>
      Stream.succeed<UIMessageChunk>({ type: 'error', errorText: error.message }),
    ),
  )
}
