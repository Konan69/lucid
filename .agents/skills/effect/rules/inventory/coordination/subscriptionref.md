# SubscriptionRef

Import `effect/SubscriptionRef`. Source `effect@4.0.2/src/SubscriptionRef.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 25. Module-name matches in Vivid: 0. No bare-name match.

## SubscriptionRef

The `SubscriptionRef` namespace containing type definitions associated with subscription references.

Source: `effect@4.0.2/src/SubscriptionRef.ts:68`.

Vivid `SubscriptionRef.SubscriptionRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SubscriptionRef<in out A> extends SubscriptionRef.Variance<A>, Pipeable {
    value: A;
    readonly semaphore: Semaphore.Semaphore;
    readonly pubsub: PubSub.PubSub<A>;
}
export declare namespace SubscriptionRef {
    interface Variance<in out A> {
        readonly [TypeId]: {
            readonly _A: Invariant<A>;
        };
    }
}
```

## isSubscriptionRef

Returns `true` if the provided value is a `SubscriptionRef`.

Source: `effect@4.0.2/src/SubscriptionRef.ts:57`.

Vivid `SubscriptionRef.isSubscriptionRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isSubscriptionRef: (u: unknown) => u is SubscriptionRef<unknown>;
```

## make

Constructs a new `SubscriptionRef` from an initial value.

Source: `effect@4.0.2/src/SubscriptionRef.ts:116`.

Vivid `SubscriptionRef.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(value: A) => Effect.Effect<SubscriptionRef<A>>;
```

## changes

Creates a stream that emits the current value and all subsequent changes to the `SubscriptionRef`.

Source: `effect@4.0.2/src/SubscriptionRef.ts:166`.

Vivid `SubscriptionRef.changes` matches: 0. No qualified match. Bare-name matches: 565. Aliased usage is unverified.

```ts
export declare const changes: <A>(self: SubscriptionRef<A>) => Stream.Stream<A>;
```

## getUnsafe

Retrieves the current value of the `SubscriptionRef` unsafely.

Source: `effect@4.0.2/src/SubscriptionRef.ts:200`.

Vivid `SubscriptionRef.getUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getUnsafe: <A>(self: SubscriptionRef<A>) => A;
```

## get

Retrieves the current value of the `SubscriptionRef`.

Source: `effect@4.0.2/src/SubscriptionRef.ts:223`.

Vivid `SubscriptionRef.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A>(self: SubscriptionRef<A>) => Effect.Effect<A>;
```

## getAndSet

Retrieves the current value and sets a new value atomically, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:249`.

Vivid `SubscriptionRef.getAndSet` matches: 0. No qualified match. Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const getAndSet: {
    <A>(value: A): (self: SubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: SubscriptionRef<A>, value: A): Effect.Effect<A>;
};
```

## getAndUpdate

Retrieves the current value and updates it atomically with the result of applying a function, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:336`.

Vivid `SubscriptionRef.getAndUpdate` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const getAndUpdate: {
    <A>(update: (a: A) => A): (self: SubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: SubscriptionRef<A>, update: (a: A) => A): Effect.Effect<A>;
};
```

## getAndUpdateEffect

Retrieves the current value and updates it atomically with the result of applying an effectful function, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:422`.

Vivid `SubscriptionRef.getAndUpdateEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getAndUpdateEffect: {
    <A, E, R>(update: (a: A) => Effect.Effect<A, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## getAndUpdateSome

Retrieves the current value and optionally updates the reference.

Source: `effect@4.0.2/src/SubscriptionRef.ts:528`.

Vivid `SubscriptionRef.getAndUpdateSome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getAndUpdateSome: {
    <A>(update: (a: A) => Option.Option<A>): (self: SubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: SubscriptionRef<A>, update: (a: A) => Option.Option<A>): Effect.Effect<A>;
};
```

## getAndUpdateSomeEffect

Retrieves the current value and optionally updates the reference effectfully.

Source: `effect@4.0.2/src/SubscriptionRef.ts:656`.

Vivid `SubscriptionRef.getAndUpdateSomeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getAndUpdateSomeEffect: {
    <A, R, E>(update: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>;
    <A, R, E>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R>;
};
```

## modify

Modifies the `SubscriptionRef` atomically with a function that computes a return value and a new value, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:776`.

Vivid `SubscriptionRef.modify` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const modify: {
    <A, B>(modify: (a: A) => readonly [
        B,
        A
    ]): (self: SubscriptionRef<A>) => Effect.Effect<B>;
    <A, B>(self: SubscriptionRef<A>, f: (a: A) => readonly [
        B,
        A
    ]): Effect.Effect<B>;
};
```

## modifyEffect

Modifies the `SubscriptionRef` atomically with an effectful function that computes a return value and a new value, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:871`.

Vivid `SubscriptionRef.modifyEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const modifyEffect: {
    <B, A, E, R>(modify: (a: A) => Effect.Effect<readonly [
        B,
        A
    ], E, R>): (self: SubscriptionRef<A>) => Effect.Effect<B, E, R>;
    <A, B, E, R>(self: SubscriptionRef<A>, modify: (a: A) => Effect.Effect<readonly [
        B,
        A
    ], E, R>): Effect.Effect<B, E, R>;
};
```

## modifySome

Computes a return value and optionally updates the reference.

Source: `effect@4.0.2/src/SubscriptionRef.ts:982`.

Vivid `SubscriptionRef.modifySome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const modifySome: {
    <B, A>(modify: (a: A) => readonly [
        B,
        Option.Option<A>
    ]): (self: SubscriptionRef<A>) => Effect.Effect<B>;
    <A, B>(self: SubscriptionRef<A>, modify: (a: A) => readonly [
        B,
        Option.Option<A>
    ]): Effect.Effect<B>;
};
```

## modifySomeEffect

Computes a return value and optionally updates the reference effectfully.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1114`.

Vivid `SubscriptionRef.modifySomeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const modifySomeEffect: {
    <A, B, R, E>(modify: (a: A) => Effect.Effect<readonly [
        B,
        Option.Option<A>
    ], E, R>): (self: SubscriptionRef<A>) => Effect.Effect<B, E, R>;
    <A, B, R, E>(self: SubscriptionRef<A>, modify: (a: A) => Effect.Effect<readonly [
        B,
        Option.Option<A>
    ], E, R>): Effect.Effect<B, E, R>;
};
```

## set

Sets the value of the `SubscriptionRef`, notifying all subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1240`.

Vivid `SubscriptionRef.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <A>(value: A): (self: SubscriptionRef<A>) => Effect.Effect<void>;
    <A>(self: SubscriptionRef<A>, value: A): Effect.Effect<void>;
};
```

## setAndGet

Sets the value of the `SubscriptionRef` and returns the new value, notifying all subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1318`.

Vivid `SubscriptionRef.setAndGet` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setAndGet: {
    <A>(value: A): (self: SubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: SubscriptionRef<A>, value: A): Effect.Effect<A>;
};
```

## update

Updates the value of the `SubscriptionRef` with the result of applying a function, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1395`.

Vivid `SubscriptionRef.update` matches: 0. No qualified match. Bare-name matches: 531. Aliased usage is unverified.

```ts
export declare const update: {
    <A>(update: (a: A) => A): (self: SubscriptionRef<A>) => Effect.Effect<void>;
    <A>(self: SubscriptionRef<A>, update: (a: A) => A): Effect.Effect<void>;
};
```

## updateEffect

Updates the value of the `SubscriptionRef` with the result of applying an effectful function, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1476`.

Vivid `SubscriptionRef.updateEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateEffect: {
    <A, E, R>(update: (a: A) => Effect.Effect<A, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<void, E, R>;
    <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<void, E, R>;
};
```

## updateAndGet

Updates the value of the `SubscriptionRef` with the result of applying a function and returns the new value, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1557`.

Vivid `SubscriptionRef.updateAndGet` matches: 0. No qualified match. Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const updateAndGet: {
    <A>(update: (a: A) => A): (self: SubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: SubscriptionRef<A>, update: (a: A) => A): Effect.Effect<A>;
};
```

## updateAndGetEffect

Updates the value of the `SubscriptionRef` with the result of applying an effectful function and returns the new value, notifying subscribers of the change.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1637`.

Vivid `SubscriptionRef.updateAndGetEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateAndGetEffect: {
    <A, E, R>(update: (a: A) => Effect.Effect<A, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## updateSome

Applies an update function to the current value. If it returns `Option.some`, sets and publishes that value; if it returns `Option.none`, leaves the reference unchanged and does not publish.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1731`.

Vivid `SubscriptionRef.updateSome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSome: {
    <A>(update: (a: A) => Option.Option<A>): (self: SubscriptionRef<A>) => Effect.Effect<void>;
    <A>(self: SubscriptionRef<A>, update: (a: A) => Option.Option<A>): Effect.Effect<void>;
};
```

## updateSomeEffect

Applies an effectful update only when it produces a new value.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1837`.

Vivid `SubscriptionRef.updateSomeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSomeEffect: {
    <A, E, R>(update: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<void, E, R>;
    <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<void, E, R>;
};
```

## updateSomeAndGet

Applies an optional update and returns the current value afterward.

Source: `effect@4.0.2/src/SubscriptionRef.ts:1963`.

Vivid `SubscriptionRef.updateSomeAndGet` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSomeAndGet: {
    <A>(update: (a: A) => Option.Option<A>): (self: SubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: SubscriptionRef<A>, update: (a: A) => Option.Option<A>): Effect.Effect<A>;
};
```

## updateSomeAndGetEffect

Applies an effectful optional update and returns the current value afterward.

Source: `effect@4.0.2/src/SubscriptionRef.ts:2083`.

Vivid `SubscriptionRef.updateSomeAndGetEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSomeAndGetEffect: {
    <A, E, R>(update: (a: A) => Effect.Effect<Option.Option<A>, E, R>): (self: SubscriptionRef<A>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: SubscriptionRef<A>, update: (a: A) => Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A, E, R>;
};
```
