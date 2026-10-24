import { Duration, Effect, Layer, Schedule, Stream } from 'effect'
import { ChannelReceiver } from './inbound.ts'
import { ChannelProvider, type ChannelInbound } from './provider.ts'

/** Paces a scoped connection supervisor, reset only by actual inbound progress. Permanent
 * project refusals stop it. Source: unmeasured. Exponential jitter starts at two seconds and
 * caps at one minute; shutdown interrupts recovery rather than imposing a daemon lifetime. */
const RECONNECT_INITIAL = '2 seconds'
const RECONNECT_CEILING = Duration.seconds(60)
const backoff = Schedule.exponential(RECONNECT_INITIAL).pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, RECONNECT_CEILING))),
)
/** Progress is the reconnect input; reset the policy without losing the scoped connection lifetime. */
export const channelReconnect = Schedule.fromStep(
  Effect.gen(function* () {
    let step = yield* Schedule.toStep(backoff)
    return Effect.fn('Channels.reconnectStep')(function* (now: number, received: boolean) {
      if (received) step = yield* Schedule.toStep(backoff)
      return yield* step(now, undefined)
    })
  }).pipe(Effect.withSpan('Channels.reconnectSchedule')),
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
  Effect.gen(function* () {
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
    yield* consume().pipe(
      Effect.repeat(channelReconnect),
      Effect.tapError(() =>
        Effect.logError('Channel connection refused; configuration repair required'),
      ),
      Effect.forkScoped,
    )
  }).pipe(Effect.withSpan('Channels.worker')),
)
