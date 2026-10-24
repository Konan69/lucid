# SynchronizedRef

Import `effect/SynchronizedRef`. Source `effect@4.0.2/src/SynchronizedRef.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 24. Module-name matches in Vivid: 0. No bare-name match.

## SynchronizedRef

A mutable reference whose update and modify operations are serialized with an internal semaphore, including effectful transformations.

Source: `effect@4.0.2/src/SynchronizedRef.ts:40`.

Vivid `SynchronizedRef.SynchronizedRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SynchronizedRef<in out A> extends Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly backing: Ref.Ref<A>;
    readonly semaphore: Semaphore.Semaphore;
}
```

## makeUnsafe

Creates a `SynchronizedRef` synchronously from an initial value.

Source: `effect@4.0.2/src/SynchronizedRef.ts:69`.

Vivid `SynchronizedRef.makeUnsafe` matches: 0. No qualified match. Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: <A>(value: A) => SynchronizedRef<A>;
```

## make

Creates a `SynchronizedRef` from an initial value, wrapped in an `Effect`.

Source: `effect@4.0.2/src/SynchronizedRef.ts:96`.

Vivid `SynchronizedRef.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(value: A) => Effect.Effect<SynchronizedRef<A>>;
```

## getUnsafe

Reads the current value synchronously, bypassing the `Effect` API and the ref's semaphore.

Source: `effect@4.0.2/src/SynchronizedRef.ts:113`.

Vivid `SynchronizedRef.getUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getUnsafe: <A>(self: SynchronizedRef<A>) => A;
```

## get

Returns an `Effect` that reads the current value of the `SynchronizedRef`.

Source: `effect@4.0.2/src/SynchronizedRef.ts:129`.

Vivid `SynchronizedRef.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A>(self: SynchronizedRef<A>) => Effect.Effect<A>;
```

## getAndSet

Sets a new value atomically and returns the previous value, serialized by the ref's semaphore.

Source: `effect@4.0.2/src/SynchronizedRef.ts:148`.

Vivid `SynchronizedRef.getAndSet` matches: 0. No qualified match. Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const getAndSet: {
    <A>(value: A): (self: SynchronizedRef<A>) => Effect.Effect<A>;
    <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<A>;
};
```

## getAndUpdate

Updates the current value atomically with a function and returns the previous value, serialized by the ref's semaphore.

Source: `effect@4.0.2/src/SynchronizedRef.ts:208`.

Vivid `SynchronizedRef.getAndUpdate` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const getAndUpdate: {
    <A>(f: (a: A) => A): (self: SynchronizedRef<A>) => Effect.Effect<A>;
    <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<A>;
};
```

## getAndUpdateEffect

Runs an effectful update atomically while holding the ref's semaphore, sets the new value if the effect succeeds, and returns the previous value.

Source: `effect@4.0.2/src/SynchronizedRef.ts:270`.

Vivid `SynchronizedRef.getAndUpdateEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getAndUpdateEffect: {
    <A, R, E>(f: (a: A) => Effect.Effect<A, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>;
    <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## getAndUpdateSome

Applies a partial update atomically and returns the previous value. If the function returns `Option.some`, the ref is updated; if it returns `Option.none`, the ref is left unchanged.

Source: `effect@4.0.2/src/SynchronizedRef.ts:340`.

Vivid `SynchronizedRef.getAndUpdateSome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getAndUpdateSome: {
    <A>(pf: (a: A) => Option.Option<A>): (self: SynchronizedRef<A>) => Effect.Effect<A>;
    <A>(self: SynchronizedRef<A>, pf: (a: A) => Option.Option<A>): Effect.Effect<A>;
};
```

## getAndUpdateSomeEffect

Runs an effectful partial update atomically while holding the ref's semaphore and returns the previous value. `Option.some` updates the ref; `Option.none` leaves it unchanged.

Source: `effect@4.0.2/src/SynchronizedRef.ts:400`.

Vivid `SynchronizedRef.getAndUpdateSomeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getAndUpdateSomeEffect: {
    <A, R, E>(pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>;
    <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R>;
};
```

## modify

Computes a return value and a new ref value atomically, stores the new value, and returns the computed result.

Source: `effect@4.0.2/src/SynchronizedRef.ts:472`.

Vivid `SynchronizedRef.modify` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const modify: {
    <A, B>(f: (a: A) => readonly [
        B,
        A
    ]): (self: SynchronizedRef<A>) => Effect.Effect<B>;
    <A, B>(self: SynchronizedRef<A>, f: (a: A) => readonly [
        B,
        A
    ]): Effect.Effect<B>;
};
```

## modifyEffect

Runs an effectful modification atomically while holding the ref's semaphore, stores the new value if the effect succeeds, and returns the computed result.

Source: `effect@4.0.2/src/SynchronizedRef.ts:531`.

Vivid `SynchronizedRef.modifyEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const modifyEffect: {
    <A, B, E, R>(f: (a: A) => Effect.Effect<readonly [
        B,
        A
    ], E, R>): (self: SynchronizedRef<A>) => Effect.Effect<B, E, R>;
    <A, B, E, R>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<readonly [
        B,
        A
    ], E, R>): Effect.Effect<B, E, R>;
};
```

## modifySome

Computes a return value and an optional new ref value atomically. `Option.some` updates the ref; `Option.none` leaves it unchanged.

Source: `effect@4.0.2/src/SynchronizedRef.ts:597`.

Vivid `SynchronizedRef.modifySome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const modifySome: {
    <B, A>(pf: (a: A) => readonly [
        B,
        Option.Option<A>
    ]): (self: SynchronizedRef<A>) => Effect.Effect<B>;
    <A, B>(self: SynchronizedRef<A>, pf: (a: A) => readonly [
        B,
        Option.Option<A>
    ]): Effect.Effect<B>;
};
```

## modifySomeEffect

Runs an effectful modification atomically while holding the ref's semaphore. The effect computes a return value and an optional new ref value; `Option.some` updates the ref and `Option.none` leaves it unchanged.

Source: `effect@4.0.2/src/SynchronizedRef.ts:657`.

Vivid `SynchronizedRef.modifySomeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const modifySomeEffect: {
    <A, B, R, E>(pf: (a: A) => Effect.Effect<readonly [
        B,
        Option.Option<A>
    ], E, R>): (self: SynchronizedRef<A>) => Effect.Effect<B, E, R>;
    <A, B, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<readonly [
        B,
        Option.Option<A>
    ], E, R>): Effect.Effect<B, E, R>;
};
```

## set

Sets the value of the `SynchronizedRef`, serialized by the ref's semaphore.

Source: `effect@4.0.2/src/SynchronizedRef.ts:731`.

Vivid `SynchronizedRef.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <A>(value: A): (self: SynchronizedRef<A>) => Effect.Effect<void>;
    <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<void>;
};
```

## setAndGet

Sets the value of the `SynchronizedRef` and returns the new value.

Source: `effect@4.0.2/src/SynchronizedRef.ts:787`.

Vivid `SynchronizedRef.setAndGet` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setAndGet: {
    <A>(value: A): (self: SynchronizedRef<A>) => Effect.Effect<A>;
    <A>(self: SynchronizedRef<A>, value: A): Effect.Effect<A>;
};
```

## update

Updates the value of the `SynchronizedRef` with a function, serialized by the ref's semaphore.

Source: `effect@4.0.2/src/SynchronizedRef.ts:843`.

Vivid `SynchronizedRef.update` matches: 0. No qualified match. Bare-name matches: 531. Aliased usage is unverified.

```ts
export declare const update: {
    <A>(f: (a: A) => A): (self: SynchronizedRef<A>) => Effect.Effect<void>;
    <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<void>;
};
```

## updateEffect

Runs an effectful update while holding the ref's semaphore and stores the new value if the effect succeeds.

Source: `effect@4.0.2/src/SynchronizedRef.ts:905`.

Vivid `SynchronizedRef.updateEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateEffect: {
    <A, R, E>(f: (a: A) => Effect.Effect<A, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<void, E, R>;
    <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<void, E, R>;
};
```

## updateAndGet

Updates the value of the `SynchronizedRef` with a function and returns the new value.

Source: `effect@4.0.2/src/SynchronizedRef.ts:973`.

Vivid `SynchronizedRef.updateAndGet` matches: 0. No qualified match. Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const updateAndGet: {
    <A>(f: (a: A) => A): (self: SynchronizedRef<A>) => Effect.Effect<A>;
    <A>(self: SynchronizedRef<A>, f: (a: A) => A): Effect.Effect<A>;
};
```

## updateAndGetEffect

Runs an effectful update while holding the ref's semaphore, stores the new value if the effect succeeds, and returns that new value.

Source: `effect@4.0.2/src/SynchronizedRef.ts:1030`.

Vivid `SynchronizedRef.updateAndGetEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateAndGetEffect: {
    <A, R, E>(f: (a: A) => Effect.Effect<A, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>;
    <A, R, E>(self: SynchronizedRef<A>, f: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## updateSome

Applies a partial update to the current value. `Option.some` stores the new value; `Option.none` leaves the ref unchanged.

Source: `effect@4.0.2/src/SynchronizedRef.ts:1093`.

Vivid `SynchronizedRef.updateSome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSome: {
    <A>(f: (a: A) => Option.Option<A>): (self: SynchronizedRef<A>) => Effect.Effect<void>;
    <A>(self: SynchronizedRef<A>, f: (a: A) => Option.Option<A>): Effect.Effect<void>;
};
```

## updateSomeEffect

Runs an effectful partial update while holding the ref's semaphore. `Option.some` stores the new value; `Option.none` leaves the ref unchanged.

Source: `effect@4.0.2/src/SynchronizedRef.ts:1150`.

Vivid `SynchronizedRef.updateSomeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSomeEffect: {
    <A, R, E>(pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<void, E, R>;
    <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<void, E, R>;
};
```

## updateSomeAndGet

Applies a partial update and returns the resulting current value. `Option.some` stores and returns the new value; `Option.none` returns the unchanged value.

Source: `effect@4.0.2/src/SynchronizedRef.ts:1219`.

Vivid `SynchronizedRef.updateSomeAndGet` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSomeAndGet: {
    <A>(pf: (a: A) => Option.Option<A>): (self: SynchronizedRef<A>) => Effect.Effect<A>;
    <A>(self: SynchronizedRef<A>, pf: (a: A) => Option.Option<A>): Effect.Effect<A>;
};
```

## updateSomeAndGetEffect

Runs an effectful partial update while holding the ref's semaphore and returns the resulting current value. `Option.some` stores and returns the new value; `Option.none` returns the unchanged value.

Source: `effect@4.0.2/src/SynchronizedRef.ts:1279`.

Vivid `SynchronizedRef.updateSomeAndGetEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSomeAndGetEffect: {
    <A, R, E>(pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SynchronizedRef<A>) => Effect.Effect<A, E, R>;
    <A, R, E>(self: SynchronizedRef<A>, pf: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R>;
};
```
