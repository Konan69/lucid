# TxSubscriptionRef

Import `effect/TxSubscriptionRef`. Source `effect@4.0.2/src/TxSubscriptionRef.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 12. Module-name matches in Vivid: 0. No bare-name match.

## TxSubscriptionRef

A TxSubscriptionRef is a transactional reference that allows subscribing to all committed changes. Subscribers receive the current value followed by every subsequent update via a transactional dequeue.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:69`.

Vivid `TxSubscriptionRef.TxSubscriptionRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TxSubscriptionRef<in out A> extends Inspectable, Pipeable {
    readonly [TypeId]: typeof TypeId;
}
```

## make

Creates a new TxSubscriptionRef with the specified initial value.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:123`.

Vivid `TxSubscriptionRef.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(value: A) => Effect.Effect<TxSubscriptionRef<A>>;
```

## get

Reads the current value of the TxSubscriptionRef.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:165`.

Vivid `TxSubscriptionRef.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A>(self: TxSubscriptionRef<A>) => Effect.Effect<A>;
```

## modify

Modifies the value of the TxSubscriptionRef using a function that returns both a result and the new value. The new value is published to all subscribers atomically.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:201`.

Vivid `TxSubscriptionRef.modify` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const modify: {
    <A, B>(f: (current: A) => [
        returnValue: B,
        newValue: A
    ]): (self: TxSubscriptionRef<A>) => Effect.Effect<B>;
    <A, B>(self: TxSubscriptionRef<A>, f: (current: A) => [
        returnValue: B,
        newValue: A
    ]): Effect.Effect<B>;
};
```

## set

Sets the value of the TxSubscriptionRef and publishes the new value to all subscribers.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:319`.

Vivid `TxSubscriptionRef.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <A>(value: A): (self: TxSubscriptionRef<A>) => Effect.Effect<void>;
    <A>(self: TxSubscriptionRef<A>, value: A): Effect.Effect<void>;
};
```

## update

Updates the value of the TxSubscriptionRef using a function and publishes the new value to all subscribers.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:415`.

Vivid `TxSubscriptionRef.update` matches: 0. No qualified match. Bare-name matches: 531. Aliased usage is unverified.

```ts
export declare const update: {
    <A>(f: (current: A) => A): (self: TxSubscriptionRef<A>) => Effect.Effect<void>;
    <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<void>;
};
```

## getAndSet

Gets the current value and sets a new value atomically. Publishes the new value to all subscribers.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:514`.

Vivid `TxSubscriptionRef.getAndSet` matches: 0. No qualified match. Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const getAndSet: {
    <A>(value: A): (self: TxSubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: TxSubscriptionRef<A>, value: A): Effect.Effect<A>;
};
```

## getAndUpdate

Gets the current value and updates it using a function atomically. Publishes the new value to all subscribers.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:612`.

Vivid `TxSubscriptionRef.getAndUpdate` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const getAndUpdate: {
    <A>(f: (current: A) => A): (self: TxSubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<A>;
};
```

## updateAndGet

Updates the value using a function and returns the new value. Publishes the new value to all subscribers.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:710`.

Vivid `TxSubscriptionRef.updateAndGet` matches: 0. No qualified match. Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const updateAndGet: {
    <A>(f: (current: A) => A): (self: TxSubscriptionRef<A>) => Effect.Effect<A>;
    <A>(self: TxSubscriptionRef<A>, f: (current: A) => A): Effect.Effect<A>;
};
```

## changes

Subscribes to all changes of the TxSubscriptionRef. Returns a scoped TxDequeue that first yields the current value, then every subsequent update.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:822`.

Vivid `TxSubscriptionRef.changes` matches: 0. No qualified match. Bare-name matches: 565. Aliased usage is unverified.

```ts
export declare const changes: <A>(self: TxSubscriptionRef<A>) => Effect.Effect<TxQueue.TxQueue<A>, never, Scope.Scope>;
```

## changesStream

Returns a Stream of all changes to the TxSubscriptionRef, starting with the current value followed by every subsequent update.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:870`.

Vivid `TxSubscriptionRef.changesStream` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const changesStream: <A>(self: TxSubscriptionRef<A>) => Stream.Stream<A, never, never>;
```

## isTxSubscriptionRef

Checks whether the given value is a TxSubscriptionRef.

Source: `effect@4.0.2/src/TxSubscriptionRef.ts:904`.

Vivid `TxSubscriptionRef.isTxSubscriptionRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxSubscriptionRef: (u: unknown) => u is TxSubscriptionRef<unknown>;
```
