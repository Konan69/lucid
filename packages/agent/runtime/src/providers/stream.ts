import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Api,
} from '@earendil-works/pi-ai'
import { Clock, Effect, Option, Predicate, Stream } from 'effect'
import { failureDiagnostic, type ModelFailure } from './failure.ts'

/** Terminal and partial events expose different message fields in the pi-ai protocol. */
const eventMessage = (event: AssistantMessageEvent): AssistantMessage => {
  if (event.type === 'done') return event.message
  if (event.type === 'error') return event.error
  return event.partial
}

/**
 * The SDK's public terminal error event owns failure delivery and resolves result(). Rejected
 * pulls would take pi-agent-core's generic exception recovery and lose typed provider evidence.
 * No SDK instance or private method is patched.
 */
export class ModelStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(
    private readonly events: Stream.Stream<AssistantMessageEvent, ModelFailure>,
    private readonly model: Model<Api>,
  ) {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message
        if (event.type === 'error') return event.error
        return event.partial
      },
    )
  }

  /** Normal error events survive pi-agent-core's result() path without copying a rejected Error.message. */
  override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    let partial = Option.none<AssistantMessage>()
    const events = this.events.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          partial = Option.some(eventMessage(event))
        }),
      ),
      Stream.catch((failure) =>
        Stream.fromEffect(
          Effect.gen({ self: this }, function* () {
            const stopped = Predicate.isTagged(failure, 'TurnStopped')
            const stopReason = stopped ? 'aborted' : 'error'
            const timestamp = yield* Clock.currentTimeMillis
            const message = Option.getOrElse(partial, (): AssistantMessage => ({
              role: 'assistant',
              content: [],
              api: this.model.api,
              provider: this.model.provider,
              model: this.model.id,
              stopReason,
              timestamp,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }))
            return {
              type: 'error',
              reason: stopReason,
              error: { ...message, stopReason, errorMessage: failureDiagnostic(failure) },
            } satisfies AssistantMessageEvent
          }),
        ),
      ),
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event.type === 'done' || event.type === 'error') this.push(event)
        }),
      ),
    )
    return Stream.toAsyncIterable(events)[Symbol.asyncIterator]()
  }
}
