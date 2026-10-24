# RcMap

Import `effect/RcMap`. Source `effect@4.0.2/src/RcMap.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 9. Module-name matches in Vivid: 23. apps/server/src/code/calls.test.ts:197, apps/server/src/code/pool.ts:12, apps/server/src/code/pool.ts:41

## RcMap

An `RcMap` is a reference-counted map data structure that manages the lifecycle of resources indexed by keys. Resources are lazily acquired and automatically released when no longer in use.

Source: `effect@4.0.2/src/RcMap.ts:75`.

Vivid `RcMap.RcMap` matches: 1. packages/agent/runtime/src/notes.ts:273 Bare-name matches: 23. Aliased usage is unverified.

```ts
export interface RcMap<in out K, in out A, in out E = never> extends Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly lookup: (key: K) => Effect.Effect<A, E, Scope.Scope>;
    readonly context: Context.Context<never>;
    readonly scope: Scope.Scope;
    readonly idleTimeToLive: (key: K) => Duration.Duration;
    readonly capacity: number;
    state: State<K, A, E>;
}
```

## State

Namespace containing the internal state types for RcMap.

Source: `effect@4.0.2/src/RcMap.ts:115`.

Vivid `RcMap.State` matches: 0. No qualified match. Bare-name matches: 50. Aliased usage is unverified.

```ts
export type State<K, A, E> = State.Open<K, A, E> | State.Closed;
export declare namespace State {
    interface Open<K, A, E> {
        readonly _tag: "Open";
        readonly map: MutableHashMap.MutableHashMap<K, Entry<A, E>>;
    }
    interface Closed {
        readonly _tag: "Closed";
    }
    interface Entry<A, E> {
        readonly deferred: Deferred.Deferred<A, E>;
        readonly scope: Scope.Closeable;
        readonly finalizer: Effect.Effect<void>;
        readonly idleTimeToLive: Duration.Duration;
        fiber: Fiber.Fiber<void> | undefined;
        expiresAt: number;
        refCount: number;
    }
}
```

## make

Creates an `RcMap` that can contain multiple reference counted resources that can be indexed by a key. The resources are lazily acquired on the first call to `get` and released when the last reference is released.

Source: `effect@4.0.2/src/RcMap.ts:245`.

Vivid `RcMap.make` matches: 3. apps/server/src/code/pool.ts:123, apps/server/src/connections/executor.ts:2000, packages/agent/runtime/src/notes.ts:274 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: {
    <K, A, E, R>(options: {
        readonly lookup: (key: K) => Effect.Effect<A, E, R>;
        readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined;
        readonly capacity?: undefined;
    }): Effect.Effect<RcMap<K, A, E>, never, Scope.Scope | R>;
    <K, A, E, R>(options: {
        readonly lookup: (key: K) => Effect.Effect<A, E, R>;
        readonly idleTimeToLive?: Duration.Input | ((key: K) => Duration.Input) | undefined;
        readonly capacity: number;
    }): Effect.Effect<RcMap<K, A, E | Cause.ExceededCapacityError>, never, Scope.Scope | R>;
};
```

## get

Gets the resource for a key, acquiring it with the map's lookup function when the key is not already cached.

Source: `effect@4.0.2/src/RcMap.ts:449`.

Vivid `RcMap.get` matches: 3. apps/server/src/code/pool.ts:137, apps/server/src/connections/executor.ts:2006, packages/agent/runtime/src/notes.ts:316 Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: {
    <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<A, E, Scope.Scope>;
    <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<A, E, Scope.Scope>;
};
```

## getOption

Retains and returns an existing resource without invoking the map's lookup function when the key is missing.

Source: `effect@4.0.2/src/RcMap.ts:642`.

Vivid `RcMap.getOption` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getOption: {
    <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<Option.Option<A>, E, Scope.Scope>;
    <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<Option.Option<A>, E, Scope.Scope>;
};
```

## keys

Returns an iterable of all keys currently stored in the `RcMap`.

Source: `effect@4.0.2/src/RcMap.ts:862`.

Vivid `RcMap.keys` matches: 0. No qualified match. Bare-name matches: 237. Aliased usage is unverified.

```ts
export declare const keys: <K, A, E>(self: RcMap<K, A, E>) => Effect.Effect<Iterable<K>>;
```

## invalidate

Invalidates and removes a specific key from the RcMap. If the resource is not currently in use (reference count is 0), it will be immediately released.

Source: `effect@4.0.2/src/RcMap.ts:914`.

Vivid `RcMap.invalidate` matches: 2. packages/agent/runtime/src/notes.ts:264, packages/agent/runtime/src/notes.ts:280 Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const invalidate: {
    <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<void>;
    <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<void>;
};
```

## has

Returns whether the `RcMap` currently contains an entry for the specified key.

Source: `effect@4.0.2/src/RcMap.ts:1047`.

Vivid `RcMap.has` matches: 0. No qualified match. Bare-name matches: 2277. Aliased usage is unverified.

```ts
export declare const has: {
    <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<boolean>;
    <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<boolean>;
};
```

## touch

Extends the idle time for a resource in the RcMap. If the RcMap has an `idleTimeToLive` configured, calling `touch` will reset the expiration timer for the specified key.

Source: `effect@4.0.2/src/RcMap.ts:1156`.

Vivid `RcMap.touch` matches: 0. No qualified match. Bare-name matches: 67. Aliased usage is unverified.

```ts
export declare const touch: {
    <K>(key: K): <A, E>(self: RcMap<K, A, E>) => Effect.Effect<void>;
    <K, A, E>(self: RcMap<K, A, E>, key: K): Effect.Effect<void>;
};
```
