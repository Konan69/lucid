import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  createResourceStore,
  createResourceStoreCache,
  type JsonValue,
  type ResourceApi,
  type ResourceEnvironment,
} from "./resource-store";

const Payload = Schema.Struct({ value: Schema.String });

/** Creates a deterministic AppState and interval authority for store lifecycle tests. */
function testEnvironment() {
  let active = true;
  let activeListener: (() => void) | null = null;
  let intervalListener: (() => void) | null = null;
  const stopActive = vi.fn();
  const stopInterval = vi.fn();
  const environment: ResourceEnvironment = {
    isActive: () => active,
    onActive: (listener) => {
      activeListener = listener;
      return stopActive;
    },
    onInterval: (listener) => {
      intervalListener = listener;
      return stopInterval;
    },
  };
  return {
    environment,
    activate: () => { if (activeListener !== null) activeListener(); },
    interval: () => { if (intervalListener !== null) intervalListener(); },
    setActive: (value: boolean) => { active = value; },
    stopActive,
    stopInterval,
  };
}

describe("resource store", () => {
  it("reuses one store per API authority and path", () => {
    const lifecycle = testEnvironment();
    const cache = createResourceStoreCache(lifecycle.environment);
    const firstApi: ResourceApi = { request: () => Promise.resolve({ value: "first" }) };
    const secondApi: ResourceApi = { request: () => Promise.resolve({ value: "second" }) };

    expect(cache.get(firstApi, "/resource")).toBe(cache.get(firstApi, "/resource"));
    expect(cache.get(firstApi, "/resource")).not.toBe(cache.get(firstApi, "/other"));
    expect(cache.get(firstApi, "/resource")).not.toBe(cache.get(secondApi, "/resource"));
  });

  it("owns polling while subscribed and ignores an obsolete request generation", async () => {
    const first = Promise.withResolvers<JsonValue>();
    const second = Promise.withResolvers<JsonValue>();
    const pending = [first, second];
    let requestIndex = 0;
    const api: ResourceApi = {
      request: () => {
        const request = pending[requestIndex];
        requestIndex += 1;
        if (request === undefined) return Promise.reject(new Error("Unexpected request"));
        return request.promise;
      },
    };
    const lifecycle = testEnvironment();
    const store = createResourceStore(api, "/resource", Payload, lifecycle.environment);
    const listener = vi.fn();

    const unsubscribeFirst = store.subscribe(listener);
    expect(store.getSnapshot()).toEqual({ _tag: "Loading" });
    unsubscribeFirst();
    expect(lifecycle.stopActive).toHaveBeenCalledOnce();
    expect(lifecycle.stopInterval).toHaveBeenCalledOnce();

    const unsubscribeSecond = store.subscribe(listener);
    first.resolve({ value: "obsolete" });
    await first.promise;
    await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ _tag: "Loading" }));

    second.resolve({ value: "current" });
    await second.promise;
    await vi.waitFor(() => expect(store.getSnapshot()).toEqual({ _tag: "Ready", value: { value: "current" } }));

    lifecycle.setActive(false);
    lifecycle.interval();
    expect(requestIndex).toBe(2);
    lifecycle.setActive(true);
    lifecycle.activate();
    expect(requestIndex).toBe(3);
    unsubscribeSecond();
  });
});
