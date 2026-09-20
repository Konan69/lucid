import { Data, Effect, Result, Schema } from 'effect'

const POLL_INTERVAL_MS = 15_000

/**
 * Where one resource is for the current subscription lifetime.
 * - `Loading`: no valid response yet.
 * - `Ready`: the latest response passed its shared wire schema.
 * - `Failed`: the transport or the schema rejected the latest response.
 */
export type ResourceState<Value> = Data.TaggedEnum<{
  Loading: {}
  Ready: { readonly value: Value }
  Failed: { readonly message: string }
}>

interface ResourceStateDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: ResourceState<this['A']>
}

/** Constructors and exhaustive matching for `ResourceState`; callers never write `_tag` by hand. */
export const ResourceState = Data.taggedEnum<ResourceStateDefinition>()

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

/** Effect program shape accepted by a client runner at the framework boundary. */
export type ResourceProgram<
  Value extends JsonValue = JsonValue,
  Failure = never,
  Requirements = never,
> = Effect.Effect<Value, Failure, Requirements>

/** Minimal typed RPC authority needed by the resource store. */
export interface ResourceApi<Program = ResourceProgram> {
  readonly load: (program: Program) => Promise<JsonValue>
}

/** Lifecycle authority injected by a platform adapter or a deterministic test. */
export interface ResourceEnvironment {
  readonly isActive: () => boolean
  readonly onActive: (listener: () => void) => () => void
  readonly onInterval: (listener: () => void, intervalMs: number) => () => void
}

/** External-store contract consumed by `useSyncExternalStore` adapters. */
export interface ResourceStore<Value> {
  readonly getSnapshot: () => ResourceState<Value>
  readonly refresh: () => Promise<void>
  readonly subscribe: (listener: () => void) => () => void
}

/** Shares one polling lifecycle for every mounted consumer of an API path. */
export interface ResourceStoreCache<Program = ResourceProgram> {
  readonly get: (
    api: ResourceApi<Program>,
    key: string,
    program: Program,
  ) => ResourceStore<JsonValue>
}

const FailureMessage = Schema.Struct({ message: Schema.String })
const decodeFailureMessage = Schema.decodeUnknownResult(FailureMessage)

/** Preserves useful adapter messages without trusting arbitrary rejection values at the boundary. */
export function failureMessage(cause: unknown): string {
  const decoded = decodeFailureMessage(cause)
  return Result.isSuccess(decoded) ? decoded.success.message : 'Could not load this. Try again.'
}

/** Creates a cache keyed by API authority and path, preventing duplicate polling loops. */
export function createResourceStoreCache<Program = ResourceProgram>(
  environment: ResourceEnvironment,
): ResourceStoreCache<Program> {
  const stores = new WeakMap<ResourceApi<Program>, Map<string, ResourceStore<JsonValue>>>()
  return {
    get: (api, key, program) => {
      let paths = stores.get(api)
      if (paths === undefined) {
        paths = new Map()
        stores.set(api, paths)
      }
      const existing = paths.get(key)
      if (existing !== undefined) return existing
      const store = createResourceStore(api, program, Schema.Json, environment)
      paths.set(key, store)
      return store
    },
  }
}

/**
 * Creates one subscriber-owned polling resource.
 * The generation token prevents an obsolete request from publishing after unsubscribe or refresh.
 */
export function createResourceStore<Value, Program = ResourceProgram>(
  api: ResourceApi<Program>,
  program: Program,
  schema: Schema.ConstraintDecoder<Value>,
  environment: ResourceEnvironment,
): ResourceStore<Value> {
  const listeners = new Set<() => void>()
  let state: ResourceState<Value> = ResourceState.Loading()
  let generation = 0
  let inFlight = false
  let stopActive: (() => void) | null = null
  let stopInterval: (() => void) | null = null

  const publish = (next: ResourceState<Value>) => {
    state = next
    for (const listener of listeners) listener()
  }

  const refresh = (): Promise<void> => {
    if (inFlight) return Promise.resolve()
    inFlight = true
    const current = ++generation
    const decoded = api.load(program).then((value) => Schema.decodeUnknownPromise(schema)(value))
    return decoded
      .then(
        (value) => {
          if (current === generation) publish(ResourceState.Ready({ value }))
        },
        (cause: unknown) => {
          if (current === generation)
            publish(ResourceState.Failed({ message: failureMessage(cause) }))
        },
      )
      .finally(() => {
        if (current === generation) inFlight = false
      })
  }

  const start = () => {
    stopActive = environment.onActive(() => {
      void refresh()
    })
    stopInterval = environment.onInterval(() => {
      if (environment.isActive()) void refresh()
    }, POLL_INTERVAL_MS)
    void refresh()
  }

  const stop = () => {
    generation += 1
    inFlight = false
    state = ResourceState.Loading()
    if (stopActive !== null) stopActive()
    if (stopInterval !== null) stopInterval()
    stopActive = null
    stopInterval = null
  }

  return {
    getSnapshot: () => state,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
  }
}
