import { Duration, Effect, Layer, Schedule, Stream } from 'effect'
import { ChannelReceiver } from './inbound.ts'
import { ChannelProvider, type ChannelInbound } from './provider.ts'

/** Capped exponential jitter avoids hammering a refused project; actual inbound progress resets it. */
const backoff = Schedule.exponential('2 seconds').pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(60))),
  ),
)
/** Progress is the reconnect input; reset the policy without losing the scoped connection lifetime. */
export const channelReconnect = Schedule.fromStep(
  Effect.fn('Channels.reconnectSchedule')(function* () {
    let step = yield* Schedule.toStep(backoff)
    return Effect.fn('Channels.reconnectStep')(function* (now: number, received: boolean) {
      if (received) step = yield* Schedule.toStep(backoff)
      return yield* step(now, undefined)
    })
  })(),
)

/** Failure evidence is a tag only; defects carry no possibly private exception payload. */
const handle = (receiver: ChannelReceiver['Service']) =>
  Effect.fn('Channels.handle')((message: ChannelInbound) =>
    receiver.receive(message).pipe(
      Effect.catch((error) =>
        Effect.logWarning('A channel message could not be handled', { reason: error._tag }),
      ),
      Effect.catchDefect(() =>
        Effect.logWarning('A channel message could not be handled', { reason: 'Defect' }),
      ),
    ),
  )

/** One scoped consumer reconnects on Schedule; one message's failure or defect cannot end the stream. */
export const channelWorkerLayer = Layer.effectDiscard(
  Effect.fn('Channels.worker')(function* () {
    const provider = yield* ChannelProvider
    const receiver = yield* ChannelReceiver
    if (provider.channels.length === 0) return
    /** Progress resets backoff even when handling that message fails. */
    const consume = Effect.fn('Channels.consume')(function* () {
      let received = false
      const receive = handle(receiver)
      const progress = Effect.sync(() => {
        received = true
      })
      yield* Stream.runForEach(provider.inbound, (message) =>
        progress.pipe(Effect.andThen(receive(message))),
      ).pipe(
        Effect.scoped,
        Effect.catchTag('ChannelDisconnected', (error) =>
          Effect.logWarning('Channel disconnected; reconnecting', { channel: error.channel }),
        ),
      )
      return received
    })
    yield* consume().pipe(Effect.repeat(channelReconnect), Effect.forkScoped)
  })(),
)
