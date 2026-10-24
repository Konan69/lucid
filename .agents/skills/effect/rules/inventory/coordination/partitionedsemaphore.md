# PartitionedSemaphore

Import `effect/PartitionedSemaphore`. Source `effect@4.0.2/src/PartitionedSemaphore.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 12. Module-name matches in Vivid: 0. No bare-name match.

## PartitionedTypeId

Literal type of the `PartitionedSemaphore` runtime type identifier.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:49`.

Vivid `PartitionedSemaphore.PartitionedTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const PartitionedTypeId: PartitionedTypeId;
export type PartitionedTypeId = "~effect/PartitionedSemaphore";
```

## PartitionedSemaphore

A `PartitionedSemaphore` controls access to a shared permit pool while tracking waiters by partition key.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:68`.

Vivid `PartitionedSemaphore.PartitionedSemaphore` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PartitionedSemaphore<in K> {
    readonly [PartitionedTypeId]: PartitionedTypeId;
    readonly capacity: number;
    readonly available: Effect.Effect<number>;
    readonly take: (key: K, permits: number) => Effect.Effect<void>;
    readonly release: (permits: number) => Effect.Effect<number>;
    readonly withPermits: (key: K, permits: number) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly withPermit: (key: K) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly withPermitsIfAvailable: (permits: number) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
}
```

## Partitioned

Alias interface for a `PartitionedSemaphore` keyed by values of type `K`.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:101`.

Vivid `PartitionedSemaphore.Partitioned` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Partitioned<in K> extends PartitionedSemaphore<K> {
}
```

## makeUnsafe

Constructs a `PartitionedSemaphore` synchronously, outside of `Effect`.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:123`.

Vivid `PartitionedSemaphore.makeUnsafe` matches: 0. No qualified match. Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: <K = unknown>(options: {
    readonly permits: number;
}) => PartitionedSemaphore<K>;
```

## make

Creates a `PartitionedSemaphore` inside an `Effect`.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:356`.

Vivid `PartitionedSemaphore.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <K = unknown>(options: {
    readonly permits: number;
}) => Effect.Effect<PartitionedSemaphore<K>>;
```

## available

Gets the current number of available permits.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:385`.

Vivid `PartitionedSemaphore.available` matches: 0. No qualified match. Bare-name matches: 173. Aliased usage is unverified.

```ts
export declare const available: <K>(self: PartitionedSemaphore<K>) => Effect.Effect<number>;
```

## capacity

Gets the total capacity.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:405`.

Vivid `PartitionedSemaphore.capacity` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const capacity: <K>(self: PartitionedSemaphore<K>) => number;
```

## take

Returns an effect that acquires the requested number of permits for the given partition key.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:435`.

Vivid `PartitionedSemaphore.take` matches: 0. No qualified match. Bare-name matches: 434. Aliased usage is unverified.

```ts
export declare const take: {
    <K>(key: K, permits: number): (self: PartitionedSemaphore<K>) => Effect.Effect<void>;
    <K>(self: PartitionedSemaphore<K>, key: K, permits: number): Effect.Effect<void>;
};
```

## release

Returns an effect that releases permits back to the shared pool and returns the current available permit count.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:519`.

Vivid `PartitionedSemaphore.release` matches: 0. No qualified match. Bare-name matches: 270. Aliased usage is unverified.

```ts
export declare const release: {
    (permits: number): <K>(self: PartitionedSemaphore<K>) => Effect.Effect<number>;
    <K>(self: PartitionedSemaphore<K>, permits: number): Effect.Effect<number>;
};
```

## withPermits

Runs an effect after acquiring permits for a partition, then releases those permits when the effect exits.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:600`.

Vivid `PartitionedSemaphore.withPermits` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const withPermits: {
    <K>(self: PartitionedSemaphore<K>, key: K, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <K, A, E, R>(self: PartitionedSemaphore<K>, key: K, permits: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## withPermit

Runs an effect after acquiring one permit for a partition, then releases the permit when the effect exits.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:701`.

Vivid `PartitionedSemaphore.withPermit` matches: 0. No qualified match. Bare-name matches: 47. Aliased usage is unverified.

```ts
export declare const withPermit: {
    <K>(self: PartitionedSemaphore<K>, key: K): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <K, A, E, R>(self: PartitionedSemaphore<K>, key: K, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## withPermitsIfAvailable

Runs an effect only when the requested permits can be acquired immediately, returning the result in `Some`.

Source: `effect@4.0.2/src/PartitionedSemaphore.ts:784`.

Vivid `PartitionedSemaphore.withPermitsIfAvailable` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const withPermitsIfAvailable: {
    <K>(self: PartitionedSemaphore<K>, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
    <K, A, E, R>(self: PartitionedSemaphore<K>, permits: number, effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R>;
};
```
