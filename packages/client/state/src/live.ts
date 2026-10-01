import { Data, Effect, Schedule, Stream } from 'effect'

/**
 * Where one live query is for as long as something is looking at it.
 * - `Loading`: subscribed, nothing received yet.
 * - `Ready`: the latest result the server sent, with any change this client is still waiting to
 *   have confirmed already applied.
 * - `Failed`: the subscription ended and will not be retried (the Person must sign in, or may not
 *   see this). A dropped connection is not a failure: the last result stays on screen while the
 *   subscription is re-opened.
 */
export type LiveState<Value, Failure> = Data.TaggedEnum<{
  Loading: {}
  Ready: { readonly value: Value }
  Failed: { readonly failure: Failure }
}>

interface LiveStateDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: LiveState<this['A'], this['B']>
}

/** Constructors and exhaustive matching for `LiveState`. */
export const LiveState = Data.taggedEnum<LiveStateDefinition>()

/** What a live query needs from its platform: somewhere to run, and a way to wait. */
export interface LiveEnvironment<Requirements> {
  /** Starts the subscription and returns how to end it. */
  readonly fork: (program: Effect.Effect<void, never, Requirements>) => () => void
  /** Calls `task` once after `milliseconds` and returns how to cancel that. */
  readonly later: (task: () => void, milliseconds: number) => () => void
}

/** The external-store contract `useSyncExternalStore` consumes, plus optimistic changes. */
export interface LiveStore<Value, Failure> {
  readonly getSnapshot: () => LiveState<Value, Failure>
  readonly subscribe: (listener: () => void) => () => void
  /**
   * Shows a change now, before the server has confirmed it. The returned function takes it back,
   * and is called when the write fails. When the write succeeds nothing more is needed: the next
   * result from the server replaces everything expected.
   */
  readonly expect: (change: (current: Value) => Value) => () => void
}

export interface LiveOptions<Failure> {
  /** Failures that end the subscription instead of being retried. */
  readonly isFinal: (failure: Failure) => boolean
  /** How long a query with nobody looking stays subscribed, so coming back is instant. */
  readonly lingerMs: number
}

/**
 * One live query as an external store.
 *
 * The first subscriber opens the server subscription and the last one closes it, after a short
 * linger so that moving between screens does not tear down and rebuild what was just on screen.
 * While nobody is looking the last result is kept; a returning subscriber sees it immediately and
 * the fresh one when it arrives. Nothing here polls: the server sends a result when it changes.
 */
export function createLiveStore<Value, Failure, Requirements>(
  environment: LiveEnvironment<Requirements>,
  stream: Stream.Stream<Value, Failure, Requirements>,
  options: LiveOptions<Failure>,
): LiveStore<Value, Failure> {
  const listeners = new Set<() => void>()
  let confirmed: LiveState<Value, Failure> = LiveState.Loading()
  let expected: ReadonlyArray<(current: Value) => Value> = []
  let snapshot: LiveState<Value, Failure> = confirmed
  let stop: (() => void) | null = null
  let cancelLinger: (() => void) | null = null

  /** Recomputes what is shown and tells React, only when it actually differs. */
  const publish = () => {
    snapshot = LiveState.$match(confirmed, {
      Loading: () => confirmed,
      Failed: () => confirmed,
      Ready: ({ value }) =>
        expected.length === 0
          ? confirmed
          : LiveState.Ready({
              value: expected.reduce((current, change) => change(current), value),
            }),
    })
    for (const listener of listeners) listener()
  }

  const received = (value: Value) =>
    Effect.sync(() => {
      confirmed = LiveState.Ready({ value })
      // The server's result already includes, or has overruled, everything this client expected.
      expected = []
      publish()
    })

  const failed = (failure: Failure) =>
    Effect.sync(() => {
      confirmed = LiveState.Failed({ failure })
      expected = []
      publish()
    })

  /**
   * The subscription. A failure that is not final (a dropped socket, an unavailable server) is
   * retried at a steady pace while the last result stays on screen (the socket underneath has its
   * own reconnect policy; this only re-opens the subscription); a final one is published and ends
   * it.
   */
  const program = Stream.runForEach(stream, received).pipe(
    Effect.retry({
      while: (failure) => !options.isFinal(failure),
      schedule: Schedule.spaced('1500 millis'),
    }),
    Effect.catch(failed),
  )

  const start = () => {
    if (cancelLinger !== null) {
      cancelLinger()
      cancelLinger = null
    }
    if (stop === null) stop = environment.fork(program)
  }

  const idle = () => {
    cancelLinger = environment.later(() => {
      cancelLinger = null
      if (listeners.size > 0 || stop === null) return
      stop()
      stop = null
    }, options.lingerMs)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) idle()
      }
    },
    expect: (change) => {
      expected = [...expected, change]
      publish()
      return () => {
        expected = expected.filter((candidate) => candidate !== change)
        publish()
      }
    },
  }
}

/** Every live query of one kind, one store per argument. */
export interface LiveFamily<Argument, Value, Failure> {
  readonly get: (argument: Argument) => LiveStore<Value, Failure>
}

/**
 * A live query that takes an argument: one Thread's detail, one shelf of the Library. Each
 * distinct argument gets its own store, and every component asking for the same one shares it, so
 * the server sees one subscription per question however many places show the answer.
 */
export function createLiveFamily<Argument, Value, Failure, Requirements>(
  environment: LiveEnvironment<Requirements>,
  options: LiveOptions<Failure>,
  query: {
    /** A string that is equal exactly when two arguments ask the same question. */
    readonly key: (argument: Argument) => string
    readonly stream: (argument: Argument) => Stream.Stream<Value, Failure, Requirements>
  },
): LiveFamily<Argument, Value, Failure> {
  const stores = new Map<string, LiveStore<Value, Failure>>()
  return {
    get: (argument) => {
      const key = query.key(argument)
      const existing = stores.get(key)
      if (existing !== undefined) return existing
      const store = createLiveStore(environment, query.stream(argument), options)
      stores.set(key, store)
      return store
    },
  }
}
