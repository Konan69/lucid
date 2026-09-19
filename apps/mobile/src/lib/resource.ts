import { useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { Schema } from "effect";
import type { Api } from "./api";
import {
  createResourceStore,
  type JsonValue,
  type ResourceApi,
  type ResourceEnvironment,
  type ResourceState,
} from "./resource-store";

const nativeResourceEnvironment: ResourceEnvironment = {
  isActive: () => AppState.currentState === "active",
  onActive: (listener) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") listener();
    });
    return () => subscription.remove();
  },
  onInterval: (listener, intervalMs) => {
    const timer = setInterval(listener, intervalMs);
    return () => clearInterval(timer);
  },
};

export interface ResourceValue<Value> {
  readonly data?: Value;
  readonly error: string;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
}

/** Maps the tagged store state to the stable legacy hook shape used by mobile screens. */
function resourceValue<Value>(
  state: ResourceState<Value>,
  refresh: () => Promise<void>,
): ResourceValue<Value> {
  switch (state._tag) {
    case "Loading":
      return { error: "", loading: true, refresh };
    case "Ready":
      return { data: state.value, error: "", loading: false, refresh };
    case "Failed":
      return { error: state.message, loading: false, refresh };
  }
  return state;
}

/** Subscribes React to a lifecycle-owned, schema-decoding resource store. */
export function useResource<Value>(
  api: Api,
  path: string,
  schema: Schema.ConstraintDecoder<Value>,
): ResourceValue<Value> {
  const store = useMemo(() => {
    const resourceApi: ResourceApi = {
      request: (resourcePath) => api.request<JsonValue>(resourcePath),
    };
    return createResourceStore(resourceApi, path, schema, nativeResourceEnvironment);
  },
    [api, path, schema],
  );
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return resourceValue(state, store.refresh);
}
