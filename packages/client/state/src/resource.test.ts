import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import {
  createResourceStore,
  createResourceStoreCache,
  type JsonValue,
  type ResourceApi,
  type ResourceEnvironment,
  ResourceDecodeError,
  ResourceState,
  type ResourceProgram,
  ResourceTransportError,
} from './resource.js'

const Payload = Schema.Struct({ value: Schema.String })
type TestProgram = ResourceProgram

/** Provides manually-driven lifecycle callbacks so tests never wait on wall-clock time. */
function testEnvironment() {
  let active = true
  const activeListeners = new Set<() => void>()
  const intervalListeners = new Set<() => void>()
  let activeStops = 0
  let intervalStops = 0
  const environment: ResourceEnvironment = {
    isActive: () => active,
    onActive: (listener) => {
      activeListeners.add(listener)
      return () => {
        activeStops += 1
        activeListeners.delete(listener)
      }
    },
    onInterval: (listener) => {
      intervalListeners.add(listener)
      return () => {
        intervalStops += 1
        intervalListeners.delete(listener)
      }
    },
  }
  return {
    environment,
    activate: () => {
      for (const listener of activeListeners) listener()
    },
    interval: () => {
      for (const listener of intervalListeners) listener()
    },
    setActive: (value: boolean) => {
      active = value
    },
    activeStopCount: () => activeStops,
    intervalStopCount: () => intervalStops,
  }
}

/** Resolves after a store listener observes the requested public state. */
function waitForState<Value>(store: { getSnapshot: () => ResourceState<Value> }, tag: string) {
  const published = Promise.withResolvers<void>()
  return {
    published,
    listener: () => {
      if (store.getSnapshot()._tag === tag) published.resolve()
    },
  }
}

describe('resource store', () => {
  it.effect('reuses one store per API authority and path', () =>
    Effect.sync(() => {
      const lifecycle = testEnvironment()
      const cache = createResourceStoreCache(lifecycle.environment)
      const firstApi: ResourceApi = { load: () => Effect.succeed({ value: 'first' }) }
      const secondApi: ResourceApi = { load: () => Effect.succeed({ value: 'second' }) }
      const program: TestProgram = Effect.succeed({ value: 'first' })

      expect(cache.get(firstApi, '/resource', program)).toBe(
        cache.get(firstApi, '/resource', program),
      )
      expect(cache.get(firstApi, '/resource', program)).not.toBe(
        cache.get(firstApi, '/other', program),
      )
      expect(cache.get(firstApi, '/resource', program)).not.toBe(
        cache.get(secondApi, '/resource', program),
      )
    }),
  )

  it.effect('owns polling while subscribed and ignores an obsolete request generation', () => {
    const lifecycle = testEnvironment()
    const requests = [
      { response: Promise.withResolvers<JsonValue>(), completed: Promise.withResolvers<void>() },
      { response: Promise.withResolvers<JsonValue>(), completed: Promise.withResolvers<void>() },
      { response: Promise.withResolvers<JsonValue>(), completed: Promise.withResolvers<void>() },
    ] as const
    let requestIndex = 0
    const api: ResourceApi = {
      load: () => {
        const request = requests[requestIndex]
        requestIndex += 1
        if (request === undefined)
          return Effect.fail(ResourceTransportError.make({ message: 'Unexpected request' }))
        return Effect.promise(() => request.response.promise).pipe(
          Effect.ensuring(Effect.sync(() => request.completed.resolve())),
        )
      },
    }
    const store = createResourceStore(
      api,
      Effect.succeed({ value: 'current' }),
      Payload,
      lifecycle.environment,
    )
    const unsubscribeFirst = store.subscribe(() => {})
    expect(store.getSnapshot()).toEqual(ResourceState.Loading())
    unsubscribeFirst()
    expect(lifecycle.activeStopCount()).toBe(1)
    expect(lifecycle.intervalStopCount()).toBe(1)

    const unsubscribeSecond = store.subscribe(() => {})
    requests[0].response.resolve({ value: 'obsolete' })

    return Effect.gen(function* () {
      yield* Effect.promise(() => requests[0].completed.promise)
      expect(store.getSnapshot()).toEqual(ResourceState.Loading())

      requests[1].response.resolve({ value: 'current' })
      yield* Effect.promise(() => requests[1].completed.promise)
      expect(store.getSnapshot()).toEqual(ResourceState.Ready({ value: { value: 'current' } }))

      lifecycle.setActive(false)
      lifecycle.interval()
      expect(requestIndex).toBe(2)

      lifecycle.setActive(true)
      lifecycle.activate()
      expect(requestIndex).toBe(3)
      requests[2].response.resolve({ value: 'current' })
      yield* Effect.promise(() => requests[2].completed.promise)
      unsubscribeSecond()
    })
  })

  it.effect('publishes Ready with the decoded value after a successful load', () => {
    const lifecycle = testEnvironment()
    const api: ResourceApi = {
      load: () => Effect.succeed({ value: 'loaded' }),
    }
    const store = createResourceStore(
      api,
      Effect.succeed({ value: 'loaded' }),
      Payload,
      lifecycle.environment,
    )
    const state = waitForState(store, 'Ready')
    const unsubscribe = store.subscribe(state.listener)

    return Effect.promise(() => state.published.promise).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(store.getSnapshot()).toEqual(ResourceState.Ready({ value: { value: 'loaded' } }))
        }),
      ),
      Effect.ensuring(Effect.sync(unsubscribe)),
    )
  })

  it.effect('publishes a tagged transport failure', () => {
    const lifecycle = testEnvironment()
    const api: ResourceApi = {
      load: () => Effect.fail(ResourceTransportError.make({ message: 'Thread not found' })),
    }
    const store = createResourceStore(
      api,
      Effect.succeed({ value: 'unused' }),
      Payload,
      lifecycle.environment,
    )
    const state = waitForState(store, 'Failed')
    const unsubscribe = store.subscribe(state.listener)

    return Effect.promise(() => state.published.promise).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const snapshot = store.getSnapshot()
          expect(snapshot._tag).toBe('Failed')
          const failure = ResourceState.$match(snapshot, {
            Loading: () => undefined,
            Ready: () => undefined,
            Failed: ({ failure: value }) => value,
          })
          expect(failure).toBeInstanceOf(ResourceTransportError)
          if (failure instanceof ResourceTransportError)
            expect(failure.message).toBe('Thread not found')
        }),
      ),
      Effect.ensuring(Effect.sync(unsubscribe)),
    )
  })

  it.effect('publishes a different tagged decode failure for malformed data', () => {
    const lifecycle = testEnvironment()
    const api: ResourceApi = {
      load: () => Effect.succeed({ value: 42 }),
    }
    const store = createResourceStore(
      api,
      Effect.succeed({ value: 'unused' }),
      Payload,
      lifecycle.environment,
    )
    const state = waitForState(store, 'Failed')
    const unsubscribe = store.subscribe(state.listener)

    return Effect.promise(() => state.published.promise).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const snapshot = store.getSnapshot()
          expect(snapshot._tag).toBe('Failed')
          const failure = ResourceState.$match(snapshot, {
            Loading: () => undefined,
            Ready: () => undefined,
            Failed: ({ failure: value }) => value,
          })
          expect(failure).toBeInstanceOf(ResourceDecodeError)
        }),
      ),
      Effect.ensuring(Effect.sync(unsubscribe)),
    )
  })

  it.effect('does not publish a response that arrives after unsubscribe', () => {
    const lifecycle = testEnvironment()
    const response = Promise.withResolvers<JsonValue>()
    const completed = Promise.withResolvers<void>()
    const api: ResourceApi = {
      load: () =>
        Effect.promise(() => response.promise).pipe(
          Effect.ensuring(Effect.sync(() => completed.resolve())),
        ),
    }
    const store = createResourceStore(
      api,
      Effect.succeed({ value: 'unused' }),
      Payload,
      lifecycle.environment,
    )
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    unsubscribe()
    response.resolve({ value: 'late' })

    return Effect.promise(() => completed.promise).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(notifications).toBe(0)
          expect(store.getSnapshot()).toEqual(ResourceState.Loading())
        }),
      ),
    )
  })
})
