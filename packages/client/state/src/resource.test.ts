import { describe, expect, it, vi } from 'vitest'
import { Effect, Schema } from 'effect'
import { NotFound } from '@vivid/contracts'
import {
  createResourceStore,
  createResourceStoreCache,
  type ResourceApi,
  type ResourceEnvironment,
  ResourceState,
  type ResourceProgram,
  type JsonValue,
} from './resource.js'

const Payload = Schema.Struct({ value: Schema.String })
type TestProgram = ResourceProgram

/** Creates a deterministic lifecycle authority for store subscription tests. */
function testEnvironment() {
  let active = true
  let activeListener: (() => void) | null = null
  let intervalListener: (() => void) | null = null
  const stopActive = vi.fn()
  const stopInterval = vi.fn()
  const environment: ResourceEnvironment = {
    isActive: () => active,
    onActive: (listener) => {
      activeListener = listener
      return stopActive
    },
    onInterval: (listener) => {
      intervalListener = listener
      return stopInterval
    },
  }
  return {
    environment,
    activate: () => {
      if (activeListener !== null) activeListener()
    },
    interval: () => {
      if (intervalListener !== null) intervalListener()
    },
    setActive: (value: boolean) => {
      active = value
    },
    stopActive,
    stopInterval,
  }
}

describe('resource store', () => {
  it('reuses one store per API authority and path', () => {
    const lifecycle = testEnvironment()
    const cache = createResourceStoreCache(lifecycle.environment)
    const firstApi: ResourceApi = { load: () => Promise.resolve({ value: 'first' }) }
    const secondApi: ResourceApi = { load: () => Promise.resolve({ value: 'second' }) }

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
  })

  it('owns polling while subscribed and ignores an obsolete request generation', async () => {
    const first = Promise.withResolvers<JsonValue>()
    const second = Promise.withResolvers<JsonValue>()
    const pending = [first, second]
    let requestIndex = 0
    const api: ResourceApi = {
      load: () => {
        const request = pending[requestIndex]
        requestIndex += 1
        return request === undefined
          ? Promise.reject(new Error('Unexpected request'))
          : request.promise
      },
    }
    const lifecycle = testEnvironment()
    const program: TestProgram = Effect.succeed({ value: 'current' })
    const store = createResourceStore(api, program, Payload, lifecycle.environment)
    const listener = vi.fn()

    const unsubscribeFirst = store.subscribe(listener)
    expect(store.getSnapshot()).toEqual(ResourceState.Loading())
    unsubscribeFirst()
    expect(lifecycle.stopActive).toHaveBeenCalledOnce()
    expect(lifecycle.stopInterval).toHaveBeenCalledOnce()

    const unsubscribeSecond = store.subscribe(listener)
    first.resolve({ value: 'obsolete' })
    await first.promise
    await vi.waitFor(() => expect(store.getSnapshot()).toEqual(ResourceState.Loading()))

    second.resolve({ value: 'current' })
    await second.promise
    await vi.waitFor(() =>
      expect(store.getSnapshot()).toEqual(ResourceState.Ready({ value: { value: 'current' } })),
    )

    lifecycle.setActive(false)
    lifecycle.interval()
    expect(requestIndex).toBe(2)
    lifecycle.setActive(true)
    lifecycle.activate()
    expect(requestIndex).toBe(3)
    unsubscribeSecond()
  })

  it('publishes a tagged RPC failure message', async () => {
    const api: ResourceApi = {
      load: () => Promise.reject(NotFound.make({ message: 'Thread not found' })),
    }
    const lifecycle = testEnvironment()
    const program: TestProgram = Effect.succeed({ value: 'unused' })
    const store = createResourceStore(api, program, Payload, lifecycle.environment)
    const unsubscribe = store.subscribe(() => {})

    await vi.waitFor(() =>
      expect(store.getSnapshot()).toEqual(ResourceState.Failed({ message: 'Thread not found' })),
    )
    unsubscribe()
  })
})
