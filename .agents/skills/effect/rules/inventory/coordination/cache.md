# Cache

Import `effect/Cache`. Source `effect@4.0.2/src/Cache.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 17. Module-name matches in Vivid: 62. apps/desktop/README.md:203, apps/desktop/src/main/signin.ts:77, apps/server/src/auth/signin.ts:469

## Cache

A cache interface that provides a mutable key-value store with automatic TTL management, capacity limits, and lookup functions for cache misses.

Source: `effect@4.0.2/src/Cache.ts:113`.

Vivid `Cache.Cache` matches: 3. apps/server/src/code/source.ts:125, apps/server/src/connections/executor.ts:1753, apps/server/src/connections/executor.ts:1784 Bare-name matches: 62. Aliased usage is unverified.

```ts
export interface Cache<in out Key, in out A, in out E = never, out R = never> extends Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly map: MutableHashMap.MutableHashMap<Key, Entry<A, E>>;
    readonly capacity: number;
    readonly lookup: (key: Key) => Effect.Effect<A, E, R>;
    readonly timeToLive: (exit: Exit.Exit<A, E>, key: Key) => Duration.Duration;
}
```

## Entry

Represents a low-level cache entry containing a deferred lookup result and an optional expiration timestamp.

Source: `effect@4.0.2/src/Cache.ts:145`.

Vivid `Cache.Entry` matches: 0. No qualified match. Bare-name matches: 37. Aliased usage is unverified.

```ts
export interface Entry<A, E> {
    expiresAt: number | undefined;
    awaiters: number;
    readonly fiber: Fiber.Fiber<A, E>;
    await(this: Entry<A, E>, fiber?: Fiber.Fiber<unknown, unknown>): Effect.Effect<A, E>;
}
```

## makeWith

Creates a cache with dynamic time-to-live based on the result and key.

Source: `effect@4.0.2/src/Cache.ts:198`.

Vivid `Cache.makeWith` matches: 8. apps/server/src/code/source.ts:193, apps/server/src/computers/boat/state.ts:36, apps/server/src/connections/effects.ts:326 Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const makeWith: <Key, A, E = never, R = never, ServiceMode extends "lookup" | "construction" = never>(lookup: (key: Key) => Effect.Effect<A, E, R>, options: {
    readonly capacity: number;
    readonly timeToLive?: ((exit: Exit.Exit<A, E>, key: Key) => Duration.Input) | undefined;
    readonly requireServicesAt?: ServiceMode | undefined;
}) => Effect.Effect<Cache<Key, A, E, "lookup" extends ServiceMode ? R : never>, never, "lookup" extends ServiceMode ? never : R>;
```

## make

Creates a cache with a fixed time-to-live for all entries.

Source: `effect@4.0.2/src/Cache.ts:297`.

Vivid `Cache.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <Key, A, E = never, R = never, ServiceMode extends "lookup" | "construction" = never>(options: {
    readonly lookup: (key: Key) => Effect.Effect<A, E, R>;
    readonly capacity: number;
    readonly timeToLive?: Duration.Input | undefined;
    readonly requireServicesAt?: ServiceMode | undefined;
}) => Effect.Effect<Cache<Key, A, E, "lookup" extends ServiceMode ? R : never>, never, "lookup" extends ServiceMode ? never : R>;
```

## get

Retrieves the value for a key, invoking the lookup function on a cache miss or expired entry.

Source: `effect@4.0.2/src/Cache.ts:430`.

Vivid `Cache.get` matches: 11. apps/server/src/code/source.ts:127, apps/server/src/code/source.ts:133, apps/server/src/computers/boat/state.ts:71 Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: {
    <Key, A>(key: Key): <E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<A, E, R>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): Effect.Effect<A, E, R>;
};
```

## getOption

Reads an existing cache entry without invoking the lookup function.

Source: `effect@4.0.2/src/Cache.ts:829`.

Vivid `Cache.getOption` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getOption: {
    <Key, A>(key: Key): <E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<Option.Option<A>, E>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): Effect.Effect<Option.Option<A>, E>;
};
```

## getSuccess

Retrieves the value associated with the specified key from the cache, only if it contains a resolved successful value.

Source: `effect@4.0.2/src/Cache.ts:1083`.

Vivid `Cache.getSuccess` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const getSuccess: {
    <Key, A, R>(key: Key): <E>(self: Cache<Key, A, E, R>) => Effect.Effect<Option.Option<A>>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): Effect.Effect<Option.Option<A>>;
};
```

## set

Sets the value associated with the specified key in the cache. This will overwrite any existing value for that key, skipping the lookup function.

Source: `effect@4.0.2/src/Cache.ts:1243`.

Vivid `Cache.set` matches: 2. apps/server/src/memory/embeddings.ts:187, packages/client/state/src/seen.ts:30 Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <Key, A>(key: Key, value: A): <E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<void>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key, value: A): Effect.Effect<void>;
};
```

## has

Checks whether the cache contains an entry for the specified key.

Source: `effect@4.0.2/src/Cache.ts:1586`.

Vivid `Cache.has` matches: 2. apps/server/src/connections/executor.ts:1877, apps/server/src/connections/executor.ts:1924 Bare-name matches: 2277. Aliased usage is unverified.

```ts
export declare const has: {
    <Key, A>(key: Key): <E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<boolean>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): Effect.Effect<boolean>;
};
```

## invalidate

Invalidates the entry associated with the specified key in the cache.

Source: `effect@4.0.2/src/Cache.ts:1844`.

Vivid `Cache.invalidate` matches: 11. apps/server/src/code/source.ts:132, apps/server/src/computers/boat/state.ts:76, apps/server/src/connections/executor.ts:1766 Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const invalidate: {
    <Key, A>(key: Key): <E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<void>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): Effect.Effect<void>;
};
```

## invalidateWhen

Invalidates the entry associated with the specified key in the cache when the predicate returns true for the cached value.

Source: `effect@4.0.2/src/Cache.ts:2018`.

Vivid `Cache.invalidateWhen` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const invalidateWhen: {
    <Key, A>(key: Key, f: Predicate<A>): <E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<boolean>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key, f: Predicate<A>): Effect.Effect<boolean>;
};
```

## refresh

Forces a refresh of the value associated with the specified key in the cache.

Source: `effect@4.0.2/src/Cache.ts:2278`.

Vivid `Cache.refresh` matches: 0. No qualified match. Bare-name matches: 51. Aliased usage is unverified.

```ts
export declare const refresh: {
    <Key, A>(key: Key): <E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<A, E, R>;
    <Key, A, E, R>(self: Cache<Key, A, E, R>, key: Key): Effect.Effect<A, E, R>;
};
```

## invalidateAll

Invalidates all entries in the cache.

Source: `effect@4.0.2/src/Cache.ts:2566`.

Vivid `Cache.invalidateAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const invalidateAll: <Key, A, E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<void>;
```

## size

Retrieves the approximate number of entries in the cache.

Source: `effect@4.0.2/src/Cache.ts:2613`.

Vivid `Cache.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <Key, A, E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<number>;
```

## keys

Retrieves all active keys from the cache, automatically filtering out expired entries.

Source: `effect@4.0.2/src/Cache.ts:2649`.

Vivid `Cache.keys` matches: 0. No qualified match. Bare-name matches: 237. Aliased usage is unverified.

```ts
export declare const keys: <Key, A, E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<Iterable<Key>>;
```

## values

Retrieves all successfully cached values from the cache, excluding failed lookups and expired entries.

Source: `effect@4.0.2/src/Cache.ts:2694`.

Vivid `Cache.values` matches: 0. No qualified match. Bare-name matches: 490. Aliased usage is unverified.

```ts
export declare const values: <Key, A, E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<Iterable<A>>;
```

## entries

Retrieves all key-value pairs from the cache as an iterable. This function only returns entries with successfully resolved values, filtering out any failed lookups or expired entries.

Source: `effect@4.0.2/src/Cache.ts:2713`.

Vivid `Cache.entries` matches: 0. No qualified match. Bare-name matches: 250. Aliased usage is unverified.

```ts
export declare const entries: <Key, A, E, R>(self: Cache<Key, A, E, R>) => Effect.Effect<Iterable<[
    Key,
    A
]>>;
```
