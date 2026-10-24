# TxPubSub

Import `effect/TxPubSub`. Source `effect@4.0.2/src/TxPubSub.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 19. Module-name matches in Vivid: 0. No bare-name match.

## TxPubSub

A TxPubSub represents a transactional publish/subscribe hub that broadcasts messages to all current subscribers using Software Transactional Memory (STM) semantics.

Source: `effect@4.0.2/src/TxPubSub.ts:55`.

Vivid `TxPubSub.TxPubSub` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TxPubSub<in out A> extends Inspectable, Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly strategy: "bounded" | "unbounded" | "dropping" | "sliding";
    readonly capacity: number;
}
```

## bounded

Creates a bounded TxPubSub with the specified capacity. When a subscriber's queue is full, the publisher will retry the transaction until space is available.

Source: `effect@4.0.2/src/TxPubSub.ts:131`.

Vivid `TxPubSub.bounded` matches: 0. No qualified match. Bare-name matches: 110. Aliased usage is unverified.

```ts
export declare const bounded: <A = never>(capacity: number) => Effect.Effect<TxPubSub<A>>;
```

## dropping

Creates a dropping TxPubSub with the specified capacity. When a subscriber's queue is full, the message is dropped for that subscriber.

Source: `effect@4.0.2/src/TxPubSub.ts:170`.

Vivid `TxPubSub.dropping` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const dropping: <A = never>(capacity: number) => Effect.Effect<TxPubSub<A>>;
```

## sliding

Creates a sliding TxPubSub with the specified capacity. When a subscriber's queue is full, the oldest message in that subscriber's queue is dropped.

Source: `effect@4.0.2/src/TxPubSub.ts:207`.

Vivid `TxPubSub.sliding` matches: 0. No qualified match. Bare-name matches: 17. Aliased usage is unverified.

```ts
export declare const sliding: <A = never>(capacity: number) => Effect.Effect<TxPubSub<A>>;
```

## unbounded

Creates an unbounded TxPubSub with unlimited capacity. Messages are always accepted.

Source: `effect@4.0.2/src/TxPubSub.ts:241`.

Vivid `TxPubSub.unbounded` matches: 0. No qualified match. Bare-name matches: 117. Aliased usage is unverified.

```ts
export declare const unbounded: <A = never>() => Effect.Effect<TxPubSub<A>>;
```

## capacity

Returns the capacity of the TxPubSub.

Source: `effect@4.0.2/src/TxPubSub.ts:272`.

Vivid `TxPubSub.capacity` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const capacity: <A>(self: TxPubSub<A>) => number;
```

## size

Returns the current number of messages across all subscriber queues (the max).

Source: `effect@4.0.2/src/TxPubSub.ts:302`.

Vivid `TxPubSub.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <A>(self: TxPubSub<A>) => Effect.Effect<number>;
```

## isEmpty

Checks whether the TxPubSub has no pending messages (all subscriber queues are empty).

Source: `effect@4.0.2/src/TxPubSub.ts:333`.

Vivid `TxPubSub.isEmpty` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const isEmpty: <A>(self: TxPubSub<A>) => Effect.Effect<boolean>;
```

## isNonEmpty

Checks whether any subscriber queue has pending messages. A pub/sub with no subscribers is empty, even if values have been published.

Source: `effect@4.0.2/src/TxPubSub.ts:363`.

Vivid `TxPubSub.isNonEmpty` matches: 0. No qualified match. Bare-name matches: 63. Aliased usage is unverified.

```ts
export declare const isNonEmpty: <A>(self: TxPubSub<A>) => Effect.Effect<boolean>;
```

## isFull

Checks whether any subscriber queue is at capacity.

Source: `effect@4.0.2/src/TxPubSub.ts:385`.

Vivid `TxPubSub.isFull` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const isFull: <A>(self: TxPubSub<A>) => Effect.Effect<boolean>;
```

## isShutdown

Checks whether the TxPubSub has been shut down.

Source: `effect@4.0.2/src/TxPubSub.ts:417`.

Vivid `TxPubSub.isShutdown` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isShutdown: <A>(self: TxPubSub<A>) => Effect.Effect<boolean>;
```

## publish

Publishes a message to all current subscribers.

Source: `effect@4.0.2/src/TxPubSub.ts:458`.

Vivid `TxPubSub.publish` matches: 0. No qualified match. Bare-name matches: 144. Aliased usage is unverified.

```ts
export declare const publish: {
    <A>(value: A): (self: TxPubSub<A>) => Effect.Effect<boolean>;
    <A>(self: TxPubSub<A>, value: A): Effect.Effect<boolean>;
};
```

## publishAll

Publishes all messages from an iterable to all current subscribers.

Source: `effect@4.0.2/src/TxPubSub.ts:591`.

Vivid `TxPubSub.publishAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const publishAll: {
    <A>(values: Iterable<A>): (self: TxPubSub<A>) => Effect.Effect<boolean>;
    <A>(self: TxPubSub<A>, values: Iterable<A>): Effect.Effect<boolean>;
};
```

## subscribe

Subscribes to the TxPubSub, returning a scoped `TxQueue` for messages published after subscription.

Source: `effect@4.0.2/src/TxPubSub.ts:715`.

Vivid `TxPubSub.subscribe` matches: 0. No qualified match. Bare-name matches: 144. Aliased usage is unverified.

```ts
export declare const subscribe: <A>(self: TxPubSub<A>) => Effect.Effect<TxQueue.TxQueue<A>, never, Scope.Scope>;
```

## acquireSubscriber

Creates a subscriber queue and registers it with the pub/sub.

Source: `effect@4.0.2/src/TxPubSub.ts:740`.

Vivid `TxPubSub.acquireSubscriber` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const acquireSubscriber: <A>(self: TxPubSub<A>) => Effect.Effect<TxQueue.TxQueue<A>, never, Effect.Transaction>;
```

## releaseSubscriber

Removes a subscriber queue from the pub/sub and shuts it down.

Source: `effect@4.0.2/src/TxPubSub.ts:774`.

Vivid `TxPubSub.releaseSubscriber` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const releaseSubscriber: {
    <A>(queue: TxQueue.TxQueue<A>): (self: TxPubSub<A>) => Effect.Effect<void, never, Effect.Transaction>;
    <A>(self: TxPubSub<A>, queue: TxQueue.TxQueue<A>): Effect.Effect<void, never, Effect.Transaction>;
};
```

## shutdown

Shuts down the TxPubSub and all subscriber queues registered at the time of shutdown.

Source: `effect@4.0.2/src/TxPubSub.ts:887`.

Vivid `TxPubSub.shutdown` matches: 0. No qualified match. Bare-name matches: 22. Aliased usage is unverified.

```ts
export declare const shutdown: <A>(self: TxPubSub<A>) => Effect.Effect<void>;
```

## awaitShutdown

Waits for the TxPubSub to be shut down.

Source: `effect@4.0.2/src/TxPubSub.ts:923`.

Vivid `TxPubSub.awaitShutdown` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitShutdown: <A>(self: TxPubSub<A>) => Effect.Effect<void>;
```

## isTxPubSub

Checks whether the given value is a TxPubSub.

Source: `effect@4.0.2/src/TxPubSub.ts:950`.

Vivid `TxPubSub.isTxPubSub` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxPubSub: (u: unknown) => u is TxPubSub<unknown>;
```
