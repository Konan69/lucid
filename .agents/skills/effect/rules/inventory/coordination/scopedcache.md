# ScopedCache

Import `effect/ScopedCache`. Source `effect@4.0.2/src/ScopedCache.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 18. Module-name matches in Vivid: 0. No bare-name match.

## ScopedCache

A scoped cache whose values are acquired by a lookup effect and stored in per-entry scopes.

Source: `effect@4.0.2/src/ScopedCache.ts:58`.

Vivid `ScopedCache.ScopedCache` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ScopedCache<in out Key, in out A, in out E = never, out R = never> extends Pipeable {
    readonly [TypeId]: typeof TypeId;
    state: State<Key, A, E>;
    readonly capacity: number;
    readonly lookup: (key: Key) => Effect.Effect<A, E, R | Scope.Scope>;
    readonly timeToLive: (exit: Exit.Exit<A, E>, key: Key) => Duration.Duration;
}
```

## State

Represents whether a `ScopedCache` is open or closed.

Source: `effect@4.0.2/src/ScopedCache.ts:83`.

Vivid `ScopedCache.State` matches: 0. No qualified match. Bare-name matches: 50. Aliased usage is unverified.

```ts
export type State<K, A, E> = {
    readonly _tag: "Open";
    readonly map: MutableHashMap.MutableHashMap<K, Entry<A, E>>;
} | {
    readonly _tag: "Closed";
};
```

## Entry

A single scoped cache entry.

Source: `effect@4.0.2/src/ScopedCache.ts:110`.

Vivid `ScopedCache.Entry` matches: 0. No qualified match. Bare-name matches: 37. Aliased usage is unverified.

```ts
export interface Entry<A, E> {
    expiresAt: number | undefined;
    readonly deferred: Deferred.Deferred<A, E>;
    readonly scope: Scope.Closeable;
    awaiters: number;
    fiber?: Fiber.Fiber<A, E>;
}
```

## makeWith

Creates a `ScopedCache` from a lookup function, maximum capacity, and a time-to-live function computed from each lookup exit and key.

Source: `effect@4.0.2/src/ScopedCache.ts:141`.

Vivid `ScopedCache.makeWith` matches: 0. No qualified match. Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const makeWith: <Key, A, E = never, R = never, ServiceMode extends "lookup" | "construction" = never>(options: {
    readonly lookup: (key: Key) => Effect.Effect<A, E, R | Scope.Scope>;
    readonly capacity: number;
    readonly timeToLive?: ((exit: Exit.Exit<A, E>, key: Key) => Duration.Input) | undefined;
    readonly requireServicesAt?: ServiceMode | undefined;
}) => Effect.Effect<ScopedCache<Key, A, E, "lookup" extends ServiceMode ? Exclude<R, Scope.Scope> : never>, never, ("lookup" extends ServiceMode ? never : R) | Scope.Scope>;
```

## make

Creates a `ScopedCache` with a fixed time-to-live for every lookup result.

Source: `effect@4.0.2/src/ScopedCache.ts:204`.

Vivid `ScopedCache.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <Key, A, E = never, R = never, ServiceMode extends "lookup" | "construction" = never>(options: {
    readonly lookup: (key: Key) => Effect.Effect<A, E, R | Scope.Scope>;
    readonly capacity: number;
    readonly timeToLive?: Duration.Input | undefined;
    readonly requireServicesAt?: ServiceMode | undefined;
}) => Effect.Effect<ScopedCache<Key, A, E, "lookup" extends ServiceMode ? Exclude<R, Scope.Scope> : never>, never, ("lookup" extends ServiceMode ? never : R) | Scope.Scope>;
```

## get

Gets the value for a key, running the cache lookup when no unexpired entry is present.

Source: `effect@4.0.2/src/ScopedCache.ts:265`.

Vivid `ScopedCache.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: {
    <Key, A>(key: Key): <E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<A, E, R>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key): Effect.Effect<A, E, R>;
};
```

## getOption

Reads an existing unexpired cache entry without running the lookup function.

Source: `effect@4.0.2/src/ScopedCache.ts:505`.

Vivid `ScopedCache.getOption` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getOption: {
    <Key, A>(key: Key): <E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<Option.Option<A>, E>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key): Effect.Effect<Option.Option<A>, E>;
};
```

## getSuccess

Retrieves the value associated with the specified key from the cache, only if it contains a resolved successful value.

Source: `effect@4.0.2/src/ScopedCache.ts:610`.

Vivid `ScopedCache.getSuccess` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const getSuccess: {
    <Key, A, R>(key: Key): <E>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<Option.Option<A>>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key): Effect.Effect<Option.Option<A>>;
};
```

## set

Sets a successful value for a key without running the lookup function.

Source: `effect@4.0.2/src/ScopedCache.ts:695`.

Vivid `ScopedCache.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <Key, A>(key: Key, value: A): <E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<void>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key, value: A): Effect.Effect<void>;
};
```

## has

Checks whether the cache contains an entry for the specified key.

Source: `effect@4.0.2/src/ScopedCache.ts:833`.

Vivid `ScopedCache.has` matches: 0. No qualified match. Bare-name matches: 2277. Aliased usage is unverified.

```ts
export declare const has: {
    <Key, A>(key: Key): <E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<boolean>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key): Effect.Effect<boolean>;
};
```

## invalidate

Removes the entry associated with a key and closes its entry scope.

Source: `effect@4.0.2/src/ScopedCache.ts:910`.

Vivid `ScopedCache.invalidate` matches: 0. No qualified match. Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const invalidate: {
    <Key, A>(key: Key): <E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<void>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key): Effect.Effect<void>;
};
```

## invalidateWhen

Invalidates the entry associated with the specified key in the cache when the predicate returns true for the cached value.

Source: `effect@4.0.2/src/ScopedCache.ts:1000`.

Vivid `ScopedCache.invalidateWhen` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const invalidateWhen: {
    <Key, A>(key: Key, f: Predicate.Predicate<A>): <E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<boolean>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key, f: Predicate.Predicate<A>): Effect.Effect<boolean>;
};
```

## refresh

Forces a refresh of the value associated with the specified key in the cache.

Source: `effect@4.0.2/src/ScopedCache.ts:1101`.

Vivid `ScopedCache.refresh` matches: 0. No qualified match. Bare-name matches: 51. Aliased usage is unverified.

```ts
export declare const refresh: {
    <Key, A>(key: Key): <E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<A, E, R>;
    <Key, A, E, R>(self: ScopedCache<Key, A, E, R>, key: Key): Effect.Effect<A, E, R>;
};
```

## invalidateAll

Removes every entry from the cache and closes each entry scope.

Source: `effect@4.0.2/src/ScopedCache.ts:1240`.

Vivid `ScopedCache.invalidateAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const invalidateAll: <Key, A, E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<void>;
```

## size

Retrieves the approximate number of entries in the cache.

Source: `effect@4.0.2/src/ScopedCache.ts:1279`.

Vivid `ScopedCache.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <Key, A, E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<number>;
```

## keys

Retrieves all active keys from the cache, automatically filtering out expired entries.

Source: `effect@4.0.2/src/ScopedCache.ts:1300`.

Vivid `ScopedCache.keys` matches: 0. No qualified match. Bare-name matches: 237. Aliased usage is unverified.

```ts
export declare const keys: <Key, A, E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<Array<Key>>;
```

## values

Retrieves all successfully cached values from the cache, excluding failed lookups and expired entries.

Source: `effect@4.0.2/src/ScopedCache.ts:1338`.

Vivid `ScopedCache.values` matches: 0. No qualified match. Bare-name matches: 490. Aliased usage is unverified.

```ts
export declare const values: <Key, A, E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<Array<A>>;
```

## entries

Retrieves all key-value pairs from the cache as an array. This function only returns entries with successfully resolved values, filtering out any failed lookups or expired entries.

Source: `effect@4.0.2/src/ScopedCache.ts:1362`.

Vivid `ScopedCache.entries` matches: 0. No qualified match. Bare-name matches: 250. Aliased usage is unverified.

```ts
export declare const entries: <Key, A, E, R>(self: ScopedCache<Key, A, E, R>) => Effect.Effect<Array<[
    Key,
    A
]>>;
```
