# Semaphore

Import `effect/Semaphore`. Source `effect@4.0.2/src/Semaphore.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 11. Module-name matches in Vivid: 50. apps/desktop/src/main/computer.ts:11, apps/desktop/src/main/computer.ts:315, apps/desktop/src/main/computer.ts:427

## Semaphore

A counting semaphore that coordinates concurrent access with permits.

Source: `effect@4.0.2/src/Semaphore.ts:59`.

Vivid `Semaphore.Semaphore` matches: 8. apps/desktop/src/main/turn.ts:129, apps/server/src/channels/store.ts:73, apps/server/src/code/process.ts:433 Bare-name matches: 50. Aliased usage is unverified.

```ts
export interface Semaphore {
    resize(this: Semaphore, permits: number): Effect.Effect<void>;
    withPermits(this: Semaphore, permits: number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    withPermit<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
    withPermitsIfAvailable(this: Semaphore, permits: number): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
    take(this: Semaphore, permits: number): Effect.Effect<number>;
    takeIfAvailable(this: Semaphore, permits: number): Effect.Effect<boolean>;
    release(this: Semaphore, permits: number): Effect.Effect<number>;
    readonly releaseAll: Effect.Effect<number>;
}
```

## makeUnsafe

Creates a `Semaphore` synchronously with the specified total number of permits.

Source: `effect@4.0.2/src/Semaphore.ts:215`.

Vivid `Semaphore.makeUnsafe` matches: 5. apps/mobile/src/data/hearing.ts:79, apps/mobile/src/data/session.ts:146, apps/server/src/code/pages.ts:7 Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: (permits: number) => Semaphore;
```

## make

Creates a `Semaphore` initialized with the specified total number of permits.

Source: `effect@4.0.2/src/Semaphore.ts:369`.

Vivid `Semaphore.make` matches: 13. apps/desktop/src/main/computer.ts:315, apps/desktop/src/main/control.ts:818, apps/desktop/src/main/settings.ts:184 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (permits: number) => Effect.Effect<Semaphore>;
```

## resize

Sets the total number of permits managed by the semaphore.

Source: `effect@4.0.2/src/Semaphore.ts:392`.

Vivid `Semaphore.resize` matches: 0. No qualified match. Bare-name matches: 30. Aliased usage is unverified.

```ts
export declare const resize: {
    (permits: number): (self: Semaphore) => Effect.Effect<void>;
    (self: Semaphore, permits: number): Effect.Effect<void>;
};
```

## withPermits

Runs an effect with the given number of permits and releases the permits when the effect completes.

Source: `effect@4.0.2/src/Semaphore.ts:462`.

Vivid `Semaphore.withPermits` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const withPermits: {
    (self: Semaphore, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: Semaphore, permits: number, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## withPermit

Runs an effect with a single permit and releases the permit when the effect completes.

Source: `effect@4.0.2/src/Semaphore.ts:534`.

Vivid `Semaphore.withPermit` matches: 8. apps/desktop/src/main/computer.ts:427, apps/desktop/src/main/control.ts:848, apps/desktop/src/main/settings.ts:192 Bare-name matches: 47. Aliased usage is unverified.

```ts
export declare const withPermit: {
    (self: Semaphore): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: Semaphore, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## withPermitsIfAvailable

Runs an effect only if the specified number of permits are immediately available.

Source: `effect@4.0.2/src/Semaphore.ts:600`.

Vivid `Semaphore.withPermitsIfAvailable` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const withPermitsIfAvailable: {
    (self: Semaphore, permits: number): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
    <A, E, R>(self: Semaphore, permits: number, effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R>;
};
```

## take

Acquires the specified number of permits and returns the acquired permit count.

Source: `effect@4.0.2/src/Semaphore.ts:674`.

Vivid `Semaphore.take` matches: 0. No qualified match. Bare-name matches: 434. Aliased usage is unverified.

```ts
export declare const take: {
    (permits: number): (self: Semaphore) => Effect.Effect<number>;
    (self: Semaphore, permits: number): Effect.Effect<number>;
};
```

## takeIfAvailable

Acquires the specified number of permits only if they are immediately available.

Source: `effect@4.0.2/src/Semaphore.ts:746`.

Vivid `Semaphore.takeIfAvailable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeIfAvailable: {
    (permits: number): (self: Semaphore) => Effect.Effect<boolean>;
    (self: Semaphore, permits: number): Effect.Effect<boolean>;
};
```

## release

Releases the specified number of permits and returns the resulting available permits.

Source: `effect@4.0.2/src/Semaphore.ts:826`.

Vivid `Semaphore.release` matches: 0. No qualified match. Bare-name matches: 270. Aliased usage is unverified.

```ts
export declare const release: {
    (permits: number): (self: Semaphore) => Effect.Effect<number>;
    (self: Semaphore, permits: number): Effect.Effect<number>;
};
```

## releaseAll

Releases all permits held by this semaphore and returns the resulting available permits.

Source: `effect@4.0.2/src/Semaphore.ts:912`.

Vivid `Semaphore.releaseAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const releaseAll: (self: Semaphore) => Effect.Effect<number>;
```
