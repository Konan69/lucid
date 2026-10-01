import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai'
import { Effect, Stream } from 'effect'
import type { ModelFailure } from './failure.ts'

/**
 * Public SDK stream adapter: iteration propagates typed failures instead of synthesizing empty
 * error Messages. Successful terminal events resolve the SDK's public result() promise.
 * No SDK instance or private method is patched.
 */
export class ModelStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(private readonly events: Stream.Stream<AssistantMessageEvent, ModelFailure>) {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message
        if (event.type === 'error') return event.error
        return event.partial
      },
    )
  }

  /** Flue's public provider API accepts this iterator and lets rejected pulls fail the submission. */
  override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return Stream.toAsyncIterable(
      this.events.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type === 'done' || event.type === 'error') this.push(event)
          }),
        ),
      ),
    )[Symbol.asyncIterator]()
  }
}
