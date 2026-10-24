# Pool

Import `effect/Pool`. Source `effect@4.0.2/src/Pool.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 13. Module-name matches in Vivid: 16. apps/server/src/auth/dialect.ts:27, apps/server/src/auth/dialect.ts:422, apps/server/src/auth/dialect.ts:479

## Pool

A `Pool<A, E>` is a pool of items of type `A`, each of which may be associated with the acquisition and release of resources. An attempt to get an item `A` from a pool may fail with an error of type `E`.

Source: `effect@4.0.2/src/Pool.ts:62`.

Vivid `Pool.Pool` matches: 0. No qualified match. Bare-name matches: 16. Aliased usage is unverified.

```ts
export interface Pool<in out A, in out E = never> extends Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly config: Config<A, E>;
    readonly state: State<A, E>;
}
```

## Config

Normalized configuration used by a `Pool`.

Source: `effect@4.0.2/src/Pool.ts:89`.

Vivid `Pool.Config` matches: 0. No qualified match. Bare-name matches: 131. Aliased usage is unverified.

```ts
export interface Config<A, E> {
    readonly acquire: Effect.Effect<A, E, Scope.Scope>;
    readonly concurrency: number;
    readonly isFixed: boolean;
    readonly minSize: number;
    readonly maxSize: number;
    readonly strategy: Strategy<A, E>;
    readonly targetUtilization: number;
}
```

## State

Mutable runtime state maintained by a `Pool`.

Source: `effect@4.0.2/src/Pool.ts:122`.

Vivid `Pool.State` matches: 0. No qualified match. Bare-name matches: 50. Aliased usage is unverified.

```ts
export interface State<A, E> {
    readonly scope: Scope.Scope;
    isShuttingDown: boolean;
    usage: number;
    readonly resizeSemaphore: Semaphore.Semaphore;
    readonly items: Set<PoolItem<A, E>>;
    availableHead: PoolItem<A, E> | undefined;
    availableTail: PoolItem<A, E> | undefined;
    readonly invalidated: Set<PoolItem<A, E>>;
    readonly waiters: Set<(failure?: Exit.Failure<A, E>) => void>;
}
```

## PoolItem

Internal record for a value managed by a `Pool`.

Source: `effect@4.0.2/src/Pool.ts:156`.

Vivid `Pool.PoolItem` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PoolItem<A, E> {
    readonly exit: Exit.Exit<A, E>;
    finalizer: Effect.Effect<void>;
    refCount: number;
    idleSince: number;
    disableReclaim: boolean;
    isAvailable: boolean;
    availablePrevious: PoolItem<A, E> | undefined;
    availableNext: PoolItem<A, E> | undefined;
    release: (exit: Exit.Exit<any, any>) => Effect.Effect<void>;
}
```

## Strategy

Strategy used by a `Pool` to manage background resizing and item reclamation.

Source: `effect@4.0.2/src/Pool.ts:190`.

Vivid `Pool.Strategy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Strategy<A, E> {
    readonly run: (pool: Pool<A, E>) => Effect.Effect<void>;
    readonly onAcquire: (item: PoolItem<A, E>) => Effect.Effect<void>;
    readonly reclaim: (pool: Pool<A, E>) => Effect.Effect<PoolItem<A, E> | undefined>;
}
```

## isPool

Returns `true` if the specified value is a `Pool`, `false` otherwise.

Source: `effect@4.0.2/src/Pool.ts:212`.

Vivid `Pool.isPool` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isPool: (u: unknown) => u is Pool<unknown, unknown>;
```

## make

Makes a new pool of the specified fixed size.

Source: `effect@4.0.2/src/Pool.ts:243`.

Vivid `Pool.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A, E, R>(options: {
    readonly acquire: Effect.Effect<A, E, R>;
    readonly size: number;
    readonly concurrency?: number | undefined;
    readonly targetUtilization?: number | undefined;
}) => Effect.Effect<Pool<A, E>, never, R | Scope.Scope>;
```

## makeWithTTL

Creates a scoped pool with minimum and maximum sizes and a time-to-live policy for shrinking unused excess items.

Source: `effect@4.0.2/src/Pool.ts:313`.

Vivid `Pool.makeWithTTL` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeWithTTL: <A, E, R>(options: {
    readonly acquire: Effect.Effect<A, E, R>;
    readonly min: number;
    readonly max: number;
    readonly concurrency?: number | undefined;
    readonly targetUtilization?: number | undefined;
    readonly timeToLive: Duration.Input;
    readonly timeToLiveStrategy?: "creation" | "usage" | undefined;
}) => Effect.Effect<Pool<A, E>, never, R | Scope.Scope>;
```

## makeWithStrategy

Creates a scoped pool using a custom resizing and reclamation strategy.

Source: `effect@4.0.2/src/Pool.ts:350`.

Vivid `Pool.makeWithStrategy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeWithStrategy: <A, E, R>(options: {
    readonly acquire: Effect.Effect<A, E, R>;
    readonly min: number;
    readonly max: number;
    readonly concurrency?: number | undefined;
    readonly targetUtilization?: number | undefined;
    readonly strategy: Strategy<A, E>;
}) => Effect.Effect<Pool<A, E>, never, Scope.Scope | R>;
```

## get

Retrieves an item from the pool in a scoped effect.

Source: `effect@4.0.2/src/Pool.ts:462`.

Vivid `Pool.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A, E>(self: Pool<A, E>) => Effect.Effect<A, E, Scope.Scope>;
```

## use

Borrows an item while an effect runs and returns it when the effect exits.

Source: `effect@4.0.2/src/Pool.ts:505`.

Vivid `Pool.use` matches: 0. No qualified match. Bare-name matches: 489. Aliased usage is unverified.

```ts
export declare const use: {
    <A, B, E2, R2>(f: (item: A) => Effect.Effect<B, E2, R2>): <E>(self: Pool<A, E>) => Effect.Effect<B, E | E2, R2>;
    <A, E, B, E2, R2>(self: Pool<A, E>, f: (item: A) => Effect.Effect<B, E2, R2>): Effect.Effect<B, E | E2, R2>;
};
```

## invalidate

Invalidates the specified item so the pool can remove it and reallocate the item, lazily if needed.

Source: `effect@4.0.2/src/Pool.ts:839`.

Vivid `Pool.invalidate` matches: 0. No qualified match. Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const invalidate: {
    <A>(item: A): <E>(self: Pool<A, E>) => Effect.Effect<void>;
    <A, E>(self: Pool<A, E>, item: A): Effect.Effect<void>;
};
```

## reserve

Reserves a leased item for exclusive use until the scope closes. This removes the item's remaining capacity from the pool but does not wait for existing leases to finish. It has no effect when per-item concurrency is `1` or the pool does not contain the item.

Source: `effect@4.0.2/src/Pool.ts:906`.

Vivid `Pool.reserve` matches: 0. No qualified match. Bare-name matches: 23. Aliased usage is unverified.

```ts
export declare const reserve: {
    <A>(item: A): <E>(self: Pool<A, E>) => Effect.Effect<void, never, Scope.Scope>;
    <A, E>(self: Pool<A, E>, item: A): Effect.Effect<void, never, Scope.Scope>;
};
```
