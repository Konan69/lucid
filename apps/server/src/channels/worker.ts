import { Effect, Layer, Schedule, Stream } from 'effect'
import { ChannelReceiver } from './inbound.ts'
import { ChannelProvider } from './provider.ts'

/** One scoped consumer reconnects on Schedule; one message's failure never closes the connection. */
export const channelWorkerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const provider = yield* ChannelProvider
    const receiver = yield* ChannelReceiver
    if (!provider.available('iMessage')) return
    yield* Stream.runForEach(provider.inbound, (message) =>
      receiver
        .receive(message)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning('A channel message could not be handled', { reason: error._tag }),
          ),
        ),
    ).pipe(
      Effect.scoped,
      Effect.catchTag('ChannelDisconnected', () =>
        Effect.logWarning('iMessage disconnected; reconnecting'),
      ),
      Effect.repeat(Schedule.spaced('2 seconds')),
      Effect.forkScoped,
    )
  }),
)
