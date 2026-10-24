# TxSemaphore

Import `effect/TxSemaphore`. Source `effect@4.0.2/src/TxSemaphore.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 14. Module-name matches in Vivid: 0. No bare-name match.

## TxSemaphore

A transactional semaphore that manages permits using Software Transactional Memory (STM) semantics, providing atomic permit acquisition and release operations within Effect transactions for concurrency control over limited resources.

Source: `effect@4.0.2/src/TxSemaphore.ts:69`.

Vivid `TxSemaphore.TxSemaphore` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TxSemaphore extends Inspectable, Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly permitsRef: TxRef.TxRef<number>;
    readonly capacity: number;
}
```

## make

Creates a new TxSemaphore with the specified number of permits.

Source: `effect@4.0.2/src/TxSemaphore.ts:131`.

Vivid `TxSemaphore.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (permits: number) => Effect.Effect<TxSemaphore>;
```

## available

Gets the current number of available permits in the semaphore.

Source: `effect@4.0.2/src/TxSemaphore.ts:177`.

Vivid `TxSemaphore.available` matches: 0. No qualified match. Bare-name matches: 173. Aliased usage is unverified.

```ts
export declare const available: (self: TxSemaphore) => Effect.Effect<number>;
```

## capacity

Gets the maximum capacity (total permits) of the semaphore.

Source: `effect@4.0.2/src/TxSemaphore.ts:211`.

Vivid `TxSemaphore.capacity` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const capacity: (self: TxSemaphore) => Effect.Effect<number>;
```

## acquire

Acquires a single permit from the semaphore. If no permits are available, the effect will block until one becomes available.

Source: `effect@4.0.2/src/TxSemaphore.ts:248`.

Vivid `TxSemaphore.acquire` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const acquire: (self: TxSemaphore) => Effect.Effect<void>;
```

## acquireN

Acquires the specified number of permits from the semaphore.

Source: `effect@4.0.2/src/TxSemaphore.ts:299`.

Vivid `TxSemaphore.acquireN` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const acquireN: {
    (n: number): (self: TxSemaphore) => Effect.Effect<void>;
    (self: TxSemaphore, n: number): Effect.Effect<void>;
};
```

## tryAcquire

Tries to acquire a single permit from the semaphore without blocking, returning `true` if successful or `false` if no permits are available.

Source: `effect@4.0.2/src/TxSemaphore.ts:434`.

Vivid `TxSemaphore.tryAcquire` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const tryAcquire: (self: TxSemaphore) => Effect.Effect<boolean>;
```

## tryAcquireN

Tries to acquire the specified number of permits from the semaphore without blocking, returning `true` if successful or `false` if not enough permits are available.

Source: `effect@4.0.2/src/TxSemaphore.ts:478`.

Vivid `TxSemaphore.tryAcquireN` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const tryAcquireN: {
    (n: number): (self: TxSemaphore) => Effect.Effect<boolean>;
    (self: TxSemaphore, n: number): Effect.Effect<boolean>;
};
```

## release

Releases one permit back to the semaphore, making it available for acquisition.

Source: `effect@4.0.2/src/TxSemaphore.ts:606`.

Vivid `TxSemaphore.release` matches: 0. No qualified match. Bare-name matches: 270. Aliased usage is unverified.

```ts
export declare const release: (self: TxSemaphore) => Effect.Effect<void>;
```

## releaseN

Releases the specified number of permits back to the semaphore.

Source: `effect@4.0.2/src/TxSemaphore.ts:652`.

Vivid `TxSemaphore.releaseN` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const releaseN: {
    (n: number): (self: TxSemaphore) => Effect.Effect<void>;
    (self: TxSemaphore, n: number): Effect.Effect<void>;
};
```

## withPermit

Executes an effect with a single permit from the semaphore. The permit is automatically acquired before execution and released afterwards, even if the effect fails or is interrupted.

Source: `effect@4.0.2/src/TxSemaphore.ts:816`.

Vivid `TxSemaphore.withPermit` matches: 0. No qualified match. Bare-name matches: 47. Aliased usage is unverified.

```ts
export declare const withPermit: {
    (self: TxSemaphore): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: TxSemaphore, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## withPermits

Runs an effect while holding the specified number of permits from the semaphore.

Source: `effect@4.0.2/src/TxSemaphore.ts:981`.

Vivid `TxSemaphore.withPermits` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const withPermits: {
    (self: TxSemaphore, n: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: TxSemaphore, n: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## withPermitScoped

Acquires a single permit from the semaphore in a scoped manner. The permit will be automatically released when the scope is closed, even if effects within the scope fail or are interrupted.

Source: `effect@4.0.2/src/TxSemaphore.ts:1150`.

Vivid `TxSemaphore.withPermitScoped` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withPermitScoped: (self: TxSemaphore) => Effect.Effect<void, never, Scope.Scope>;
```

## isTxSemaphore

Determines if the provided value is a TxSemaphore.

Source: `effect@4.0.2/src/TxSemaphore.ts:1193`.

Vivid `TxSemaphore.isTxSemaphore` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxSemaphore: (u: unknown) => u is TxSemaphore;
```
