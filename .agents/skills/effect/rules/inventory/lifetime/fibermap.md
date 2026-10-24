# FiberMap

Import `effect/FiberMap`. Source `effect@4.0.2/src/FiberMap.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 19. Module-name matches in Vivid: 0. No bare-name match.

## FiberMap

A FiberMap is a collection of fibers, indexed by a key. When the associated Scope is closed, all fibers in the map will be interrupted. Fibers are automatically removed from the map when they complete.

Source: `effect@4.0.2/src/FiberMap.ts:62`.

Vivid `FiberMap.FiberMap` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FiberMap<in out K, out A = unknown, out E = unknown> extends Pipeable, Inspectable.Inspectable, Iterable<[
    K,
    Fiber.Fiber<A, E>
]> {
    readonly [TypeId]: typeof TypeId;
    readonly deferred: Deferred.Deferred<void, unknown>;
    state: {
        readonly _tag: "Open";
        readonly backing: MutableHashMap.MutableHashMap<K, Fiber.Fiber<A, E>>;
    } | {
        readonly _tag: "Closed";
    };
}
```

## isFiberMap

Returns `true` if a value is a `FiberMap`.

Source: `effect@4.0.2/src/FiberMap.ts:101`.

Vivid `FiberMap.isFiberMap` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isFiberMap: (u: unknown) => u is FiberMap<unknown>;
```

## make

Creates a scoped `FiberMap` for storing fibers by key.

Source: `effect@4.0.2/src/FiberMap.ts:166`.

Vivid `FiberMap.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <K, A = unknown, E = unknown>() => Effect.Effect<FiberMap<K, A, E>, never, Scope.Scope>;
```

## makeRuntime

Creates a scoped run function that forks effects into a new `FiberMap`.

Source: `effect@4.0.2/src/FiberMap.ts:219`.

Vivid `FiberMap.makeRuntime` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const makeRuntime: <R, K, E = unknown, A = unknown>() => Effect.Effect<<XE extends E, XA extends A>(key: K, effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly onlyIfMissing?: boolean | undefined;
}) | undefined) => Fiber.Fiber<XA, XE>, never, Scope.Scope | R>;
```

## makeRuntimePromise

Creates a scoped run function that forks effects into a new `FiberMap` and returns a `Promise` for each effect result.

Source: `effect@4.0.2/src/FiberMap.ts:277`.

Vivid `FiberMap.makeRuntimePromise` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeRuntimePromise: <R, K, A = unknown, E = unknown>() => Effect.Effect<<XE extends E, XA extends A>(key: K, effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly onlyIfMissing?: boolean | undefined;
}) | undefined) => Promise<XA>, never, Scope.Scope | R>;
```

## setUnsafe

Adds a fiber to the `FiberMap` under a key using a synchronous, unsafe mutation.

Source: `effect@4.0.2/src/FiberMap.ts:344`.

Vivid `FiberMap.setUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setUnsafe: {
    <K, A, E, XE extends E, XA extends A>(key: K, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): (self: FiberMap<K, A, E>) => void;
    <K, A, E, XE extends E, XA extends A>(self: FiberMap<K, A, E>, key: K, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): void;
};
```

## set

Adds a fiber to the `FiberMap` under a key.

Source: `effect@4.0.2/src/FiberMap.ts:537`.

Vivid `FiberMap.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <K, A, E, XE extends E, XA extends A>(key: K, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): (self: FiberMap<K, A, E>) => Effect.Effect<void>;
    <K, A, E, XE extends E, XA extends A>(self: FiberMap<K, A, E>, key: K, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): Effect.Effect<void>;
};
```

## getUnsafe

Retrieves a fiber from the FiberMap synchronously.

Source: `effect@4.0.2/src/FiberMap.ts:679`.

Vivid `FiberMap.getUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getUnsafe: {
    <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Option.Option<Fiber.Fiber<A, E>>;
    <K, A, E>(self: FiberMap<K, A, E>, key: K): Option.Option<Fiber.Fiber<A, E>>;
};
```

## get

Retrieves a fiber from the FiberMap effectfully.

Source: `effect@4.0.2/src/FiberMap.ts:796`.

Vivid `FiberMap.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: {
    <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Effect.Effect<Option.Option<Fiber.Fiber<A, E>>>;
    <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<Option.Option<Fiber.Fiber<A, E>>>;
};
```

## hasUnsafe

Checks whether a key exists in the FiberMap.

Source: `effect@4.0.2/src/FiberMap.ts:901`.

Vivid `FiberMap.hasUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const hasUnsafe: {
    <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => boolean;
    <K, A, E>(self: FiberMap<K, A, E>, key: K): boolean;
};
```

## has

Checks whether a key exists in the FiberMap. This is the Effect-wrapped version of `hasUnsafe`.

Source: `effect@4.0.2/src/FiberMap.ts:989`.

Vivid `FiberMap.has` matches: 0. No qualified match. Bare-name matches: 2277. Aliased usage is unverified.

```ts
export declare const has: {
    <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Effect.Effect<boolean>;
    <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<boolean>;
};
```

## remove

Removes a fiber from the FiberMap, interrupting it if it exists.

Source: `effect@4.0.2/src/FiberMap.ts:1082`.

Vivid `FiberMap.remove` matches: 0. No qualified match. Bare-name matches: 251. Aliased usage is unverified.

```ts
export declare const remove: {
    <K>(key: K): <A, E>(self: FiberMap<K, A, E>) => Effect.Effect<void>;
    <K, A, E>(self: FiberMap<K, A, E>, key: K): Effect.Effect<void>;
};
```

## clear

Removes all fibers from the FiberMap, interrupting them.

Source: `effect@4.0.2/src/FiberMap.ts:1256`.

Vivid `FiberMap.clear` matches: 0. No qualified match. Bare-name matches: 107. Aliased usage is unverified.

```ts
export declare const clear: <K, A, E>(self: FiberMap<K, A, E>) => Effect.Effect<void>;
```

## run

Forks an Effect and stores the resulting fiber in the `FiberMap` under a key.

Source: `effect@4.0.2/src/FiberMap.ts:1310`.

Vivid `FiberMap.run` matches: 0. No qualified match. Bare-name matches: 1579. Aliased usage is unverified.

```ts
export declare const run: {
    <K, A, E>(self: FiberMap<K, A, E>, key: K, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
        readonly startImmediately?: boolean | undefined;
    } | undefined): <R, XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>) => Effect.Effect<Fiber.Fiber<XA, XE>, never, R>;
    <K, A, E, R, XE extends E, XA extends A>(self: FiberMap<K, A, E>, key: K, effect: Effect.Effect<XA, XE, R>, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
        readonly startImmediately?: boolean | undefined;
    } | undefined): Effect.Effect<Fiber.Fiber<XA, XE>, never, R>;
};
```

## runtime

Captures the current runtime and returns a function for forking effects into an existing `FiberMap`.

Source: `effect@4.0.2/src/FiberMap.ts:1480`.

Vivid `FiberMap.runtime` matches: 0. No qualified match. Bare-name matches: 785. Aliased usage is unverified.

```ts
export declare const runtime: <K, A, E>(self: FiberMap<K, A, E>) => <R = never>() => Effect.Effect<<XE extends E, XA extends A>(key: K, effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly onlyIfMissing?: boolean | undefined;
    readonly propagateInterruption?: boolean | undefined;
}) | undefined) => Fiber.Fiber<XA, XE>, never, R>;
```

## runtimePromise

Captures the current runtime and returns a function for running effects in an existing `FiberMap` as Promises.

Source: `effect@4.0.2/src/FiberMap.ts:1558`.

Vivid `FiberMap.runtimePromise` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runtimePromise: <K, A, E>(self: FiberMap<K, A, E>) => <R = never>() => Effect.Effect<<XE extends E, XA extends A>(key: K, effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly onlyIfMissing?: boolean | undefined;
    readonly propagateInterruption?: boolean | undefined;
}) | undefined) => Promise<XA>, never, R>;
```

## size

Gets the number of fibers currently in the FiberMap.

Source: `effect@4.0.2/src/FiberMap.ts:1622`.

Vivid `FiberMap.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <K, A, E>(self: FiberMap<K, A, E>) => Effect.Effect<number>;
```

## join

Waits for the `FiberMap` to fail or close.

Source: `effect@4.0.2/src/FiberMap.ts:1656`.

Vivid `FiberMap.join` matches: 0. No qualified match. Bare-name matches: 601. Aliased usage is unverified.

```ts
export declare const join: <K, A, E>(self: FiberMap<K, A, E>) => Effect.Effect<void, E>;
```

## awaitEmpty

Waits for the FiberMap to be empty. This will wait for all currently running fibers to complete.

Source: `effect@4.0.2/src/FiberMap.ts:1688`.

Vivid `FiberMap.awaitEmpty` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitEmpty: <K, A, E>(self: FiberMap<K, A, E>) => Effect.Effect<void, E>;
```
