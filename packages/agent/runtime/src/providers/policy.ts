import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  Provider,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { Clock, Config, Effect, Predicate, Ref, Schedule, Schema, Stream } from 'effect'
import {
  ModelName,
  NoAnswer,
  TimedOut,
  TurnStopped,
  ModelUnavailable,
  readModelEvent,
  ModelConfigurationInvalid,
  providerFailure,
  retryable,
  type ModelFailure,
} from './failure.ts'

type CompletionModel = Model<'openai-completions'>

/** Invalid list entries fail configuration instead of silently dropping a requested fallback. */
const ModelList = Schema.String.check(Schema.isPattern(/^\s*[^,\s]+\s*(,\s*[^,\s]+\s*)*$/u))
const PositiveMillis = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))

/** One first-token budget encloses the complete ordered model selection, including retry delays. */
export const modelConfiguration = Effect.fn('Models.configuration')(function* (
  primary: CompletionModel,
  provider: Provider<'openai-completions'>,
) {
  const list = yield* Config.schema(ModelList, 'VIVID_MODEL_FALLBACKS').pipe(
    Config.withDefault(`openrouter/${primary.id}`),
  )
  const firstTokenMillis = yield* Config.schema(
    PositiveMillis,
    'VIVID_RUN_FIRST_TOKEN_TIMEOUT_MS',
  ).pipe(Config.withDefault(90_000))
  const attemptMillis = yield* Config.schema(PositiveMillis, 'VIVID_MODEL_ATTEMPT_TIMEOUT_MS').pipe(
    Config.withDefault(10_000),
  )
  const names = [
    ...new Set([
      primary.id,
      ...list.split(',').map((name) => name.trim().replace(/^openrouter\//u, '')),
    ]),
  ]
  const models = yield* Effect.forEach(names, (id) => {
    const model = provider.getModels().find((candidate) => candidate.id === id)
    return model === undefined
      ? Effect.fail(new ModelConfigurationInvalid())
      : Effect.succeed(model)
  })
  return { models, firstTokenMillis, attemptMillis }
})

/** Only an answer or tool call escapes buffering; reasoning alone cannot forfeit invisible retries. */
const meaningful = (event: AssistantMessageEvent): boolean => {
  if (event.type === 'text_delta') return event.delta.trim().length > 0
  if (event.type === 'toolcall_end') return event.toolCall.name.length > 0
  if (event.type === 'done')
    return event.message.content.some(
      (part) => part.type === 'toolCall' || (part.type === 'text' && part.text.trim().length > 0),
    )
  return false
}

/** A provider error is terminal evidence, rather than an assistant Message to persist. */
const checked = Effect.fn('Models.checked')(function* (
  event: AssistantMessageEvent,
  name: ModelName,
) {
  if (event.type === 'error') {
    if (event.reason === 'aborted') return yield* Effect.fail(new TurnStopped({ model: name }))
    const message = event.error.errorMessage
    return yield* Effect.fail(
      providerFailure(
        name,
        message === undefined ? 'Provider failed without diagnostics' : message,
      ),
    )
  }
  if (event.type === 'done' && !meaningful(event))
    return yield* Effect.fail(new NoAnswer({ model: name }))
  return event
})

/** Read to the first content before exposing any SDK start event; a failed attempt has no visible footprint. */
const prepare = Effect.fn('Models.prepare')(function* (
  iterator: AsyncIterator<AssistantMessageEvent>,
  name: ModelName,
  attemptMillis: number,
) {
  const buffered: AssistantMessageEvent[] = []
  while (true) {
    // The attempt budget measures provider liveness. After any event, only the overall
    // visible-content deadline applies; reasoning remains buffered and cannot disable retries.
    const pull = readModelEvent(iterator, name)
    const next = yield* buffered.length === 0
      ? pull.pipe(
          Effect.timeoutOrElse({
            duration: attemptMillis,
            orElse: () => Effect.fail(new TimedOut({ model: name })),
          }),
        )
      : pull
    if (next.done) return yield* Effect.fail(new NoAnswer({ model: name }))
    const event = yield* checked(next.value, name)
    buffered.push(event)
    if (meaningful(event)) return buffered
  }
})

interface Attempt {
  readonly provider: Provider<'openai-completions'>
  readonly model: CompletionModel
  readonly context: Context
  readonly options: SimpleStreamOptions
  readonly attemptMillis: number
  readonly visible: Ref.Ref<boolean>
}

/** Abort and iterator cleanup belong to the attempt's stream scope, including timeout and fallback. */
const attempt = (input: Attempt) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const name = ModelName.make(input.model.id)
      const signal = yield* Effect.abortSignal
      const caller = input.options.signal
      const combined = caller === undefined ? signal : AbortSignal.any([caller, signal])
      const source: AssistantMessageEventStream = input.provider.streamSimple(
        input.model,
        input.context,
        {
          ...input.options,
          signal: combined,
          maxRetries: 0,
          timeoutMs: input.attemptMillis,
        },
      )
      const iterator = source[Symbol.asyncIterator]()
      const buffered = yield* prepare(iterator, name, input.attemptMillis)
      yield* Ref.set(input.visible, true)
      const tail = Stream.unfold(iterator, (current) =>
        readModelEvent(current, name).pipe(
          Effect.map((next) => (next.done ? undefined : ([next.value, current] as const))),
        ),
      ).pipe(Stream.mapEffect((event) => checked(event, name)))
      return Stream.concat(Stream.fromIterable(buffered), tail)
    }),
  )

/**
 * Model-only retries cannot replay tools: every failed attempt is still invisible. Once content
 * escapes, failures remain terminal. The global deadline is disabled by the first content token.
 */
export const modelStream = (
  provider: Provider<'openai-completions'>,
  primary: CompletionModel,
  context: Context,
  options: SimpleStreamOptions,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const config = yield* modelConfiguration(primary, provider).pipe(
        Effect.mapError(() => new ModelConfigurationInvalid()),
      )
      const visible = yield* Ref.make(false)
      const first = yield* Clock.currentTimeMillis
      /** Exhaust one model before selecting the next; visible work is never replayed. */
      const choose = (index: number): Stream.Stream<AssistantMessageEvent, ModelFailure> => {
        const model = config.models[index]
        if (model === undefined)
          return Stream.fail(
            new ModelUnavailable({ model: ModelName.make(primary.id), transient: false }),
          )
        const call = attempt({
          provider,
          model,
          context,
          options,
          attemptMillis: config.attemptMillis,
          visible,
        })
        const schedule = Schedule.exponential('250 millis').pipe(
          Schedule.setInputType<ModelFailure>(),
          Schedule.upTo({ times: 2 }),
          Schedule.while((meta) =>
            Effect.map(Ref.get(visible), (shown) => !shown && retryable(meta.input)),
          ),
        )
        return call.pipe(
          Stream.retry(schedule),
          Stream.catch((failure) =>
            Stream.unwrap(
              Effect.gen(function* () {
                if (yield* Ref.get(visible)) return Stream.fail(failure)
                if (
                  Predicate.isTagged(failure, 'TurnStopped') ||
                  index + 1 === config.models.length
                )
                  return Stream.fail(failure)
                return choose(index + 1)
              }),
            ),
          ),
        )
      }
      const deadline = Effect.fn('Models.firstTokenDeadline')(function* () {
        const remaining = Math.max(
          0,
          config.firstTokenMillis - ((yield* Clock.currentTimeMillis) - first),
        )
        yield* Effect.sleep(remaining)
        if (!(yield* Ref.get(visible)))
          return yield* Effect.fail(new TimedOut({ model: ModelName.make(primary.id) }))
        return yield* Effect.never
      })
      return choose(0).pipe(Stream.interruptWhen(deadline()))
    }),
  )
