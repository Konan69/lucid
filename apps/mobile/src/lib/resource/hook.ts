import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { Result, Schema } from 'effect'
import type { Api, RpcProgram } from '../api'
import {
  createResourceStoreCache,
  failureMessage,
  type JsonValue,
  type ResourceApi,
  type ResourceEnvironment,
  ResourceState,
} from './store'

const nativeResourceEnvironment: ResourceEnvironment = {
  isActive: () => AppState.currentState === 'active',
  onActive: (listener) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') listener()
    })
    return () => subscription.remove()
  },
  onInterval: (listener, intervalMs) => {
    const timer = setInterval(listener, intervalMs)
    return () => clearInterval(timer)
  },
}

const resourceStoreCache = createResourceStoreCache(nativeResourceEnvironment)
const resourceApis = new WeakMap<Api, ResourceApi>()

/** Returns one stable resource authority for each API client. */
function resourceApiFor(api: Api): ResourceApi {
  const existing = resourceApis.get(api)
  if (existing !== undefined) return existing
  const resourceApi: ResourceApi = {
    load: (program) => api.run(program),
  }
  resourceApis.set(api, resourceApi)
  return resourceApi
}

export interface ResourceValue<Value extends JsonValue> {
  readonly data?: Value
  readonly error: string
  readonly loading: boolean
  readonly refresh: () => Promise<void>
}

/** Maps the tagged store state to the stable legacy hook shape used by mobile screens. */
function resourceValue<Value extends JsonValue>(
  state: ResourceState<JsonValue>,
  schema: Schema.ConstraintDecoder<Value>,
  refresh: () => Promise<void>,
): ResourceValue<Value> {
  return ResourceState.$match(state, {
    Loading: (): ResourceValue<Value> => ({ error: '', loading: true, refresh }),
    Ready: (ready): ResourceValue<Value> => {
      const decoded = Schema.decodeUnknownResult(schema)(ready.value)
      return Result.isSuccess(decoded)
        ? { data: decoded.success, error: '', loading: false, refresh }
        : { error: failureMessage(decoded.failure), loading: false, refresh }
    },
    Failed: (failed): ResourceValue<Value> => ({ error: failed.message, loading: false, refresh }),
  })
}

/** Subscribes React to a lifecycle-owned, schema-decoding resource store. */
export function useResource<Value extends JsonValue>(
  api: Api,
  key: string,
  program: RpcProgram<Value>,
  schema: Schema.ConstraintDecoder<Value>,
): ResourceValue<Value> {
  const store = resourceStoreCache.get(resourceApiFor(api), key, program)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return resourceValue(state, schema, store.refresh)
}
