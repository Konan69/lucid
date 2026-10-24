# PubSub

Import `effect/PubSub`. Source `effect@4.0.2/src/PubSub.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 34. Module-name matches in Vivid: 26. apps/server/src/computers/egress/relay.test.ts:28, apps/server/src/computers/egress/relay.test.ts:130, apps/server/src/computers/egress/relay.test.ts:132

## PubSub

Companion namespace containing the low-level building blocks used by `PubSub`, including atomic implementations, backing subscriptions, replay windows, and delivery strategies.

Source: `effect@4.0.2/src/PubSub.ts:89`.

Vivid `PubSub.PubSub` matches: 0. No qualified match. Bare-name matches: 26. Aliased usage is unverified.

```ts
export interface PubSub<in out A> extends Pipeable {
    readonly [TypeId]: {
        readonly _A: Invariant<A>;
    };
    readonly pubsub: PubSub.Atomic<A>;
    readonly subscribers: PubSub.Subscribers<A>;
    readonly scope: Scope.Closeable;
    readonly shutdownHook: Latch.Latch;
    readonly shutdownFlag: MutableRef.MutableRef<boolean>;
    readonly strategy: PubSub.Strategy<A>;
    readonly ended: MutableRef.MutableRef<Option.Option<A>>;
}
export declare namespace PubSub {
    interface Atomic<in out A> {
        readonly capacity: number;
        isEmpty(): boolean;
        isFull(): boolean;
        size(): number;
        publish(value: A): boolean;
        publishAll(elements: Iterable<A>): Array<A>;
        slide(): void;
        subscribe(): BackingSubscription<A>;
        replayWindow(): ReplayWindow<A>;
    }
    interface BackingSubscription<out A> {
        isEmpty(): boolean;
        size(): number;
        poll(): A | MutableList.Empty;
        pollUpTo(n: number): Array<A>;
        unsubscribe(): void;
    }
    type Subscribers<A> = Map<BackingSubscription<A>, Set<MutableList.MutableList<Deferred.Deferred<A>>>>;
    interface ReplayWindow<A> {
        take(): A | undefined;
        takeN(n: number): Array<A>;
        takeAll(): Array<A>;
        close(): void;
        readonly remaining: number;
    }
    interface Strategy<in out A> {
        readonly shutdown: Effect.Effect<void>;
        handleSurplus(pubsub: Atomic<A>, subscribers: Subscribers<A>, elements: Iterable<A>, isShutdown: MutableRef.MutableRef<boolean>, ended: MutableRef.MutableRef<Option.Option<A>>): Effect.Effect<boolean>;
        onPubSubEmptySpaceUnsafe(pubsub: Atomic<A>, subscribers: Subscribers<A>): void;
        completePollersUnsafe(pubsub: Atomic<A>, subscribers: Subscribers<A>, subscription: BackingSubscription<A>, pollers: MutableList.MutableList<Deferred.Deferred<A>>): void;
        completeSubscribersUnsafe(pubsub: Atomic<A>, subscribers: Subscribers<A>): void;
    }
}
```

## isPubSub

Returns `true` if a value is a `PubSub`.

Source: `effect@4.0.2/src/PubSub.ts:239`.

Vivid `PubSub.isPubSub` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isPubSub: <A = unknown>(u: unknown) => u is PubSub<A>;
```

## Subscription

A subscription represents a consumer's connection to a PubSub, allowing them to take messages.

Source: `effect@4.0.2/src/PubSub.ts:276`.

Vivid `PubSub.Subscription` matches: 1. apps/server/src/computers/egress/relay.test.ts:889 Bare-name matches: 18. Aliased usage is unverified.

```ts
export interface Subscription<out A> extends Pipeable {
    readonly [SubscriptionTypeId]: {
        readonly _A: Covariant<A>;
    };
    readonly pubsub: PubSub.Atomic<any>;
    readonly subscribers: PubSub.Subscribers<any>;
    readonly subscription: PubSub.BackingSubscription<A>;
    readonly pollers: MutableList.MutableList<Deferred.Deferred<any>>;
    readonly shutdownHook: Latch.Latch;
    readonly shutdownFlag: MutableRef.MutableRef<boolean>;
    readonly strategy: PubSub.Strategy<any>;
    readonly replayWindow: PubSub.ReplayWindow<A>;
    readonly ended: MutableRef.MutableRef<Option.Option<any>>;
}
```

## make

Creates a PubSub with a custom atomic implementation and strategy.

Source: `effect@4.0.2/src/PubSub.ts:320`.

Vivid `PubSub.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(options: {
    readonly atomicPubSub: LazyArg<PubSub.Atomic<A>>;
    readonly strategy: LazyArg<PubSub.Strategy<A>>;
}) => Effect.Effect<PubSub<A>>;
```

## bounded

Creates a bounded `PubSub` that applies backpressure when it reaches capacity.

Source: `effect@4.0.2/src/PubSub.ts:380`.

Vivid `PubSub.bounded` matches: 0. No qualified match. Bare-name matches: 110. Aliased usage is unverified.

```ts
export declare const bounded: <A>(capacity: number | {
    readonly capacity: number;
    readonly replay?: number | undefined;
}) => Effect.Effect<PubSub<A>>;
```

## dropping

Creates a bounded `PubSub` with the dropping strategy. The `PubSub` will drop new messages if the `PubSub` is at capacity.

Source: `effect@4.0.2/src/PubSub.ts:430`.

Vivid `PubSub.dropping` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const dropping: <A>(capacity: number | {
    readonly capacity: number;
    readonly replay?: number | undefined;
}) => Effect.Effect<PubSub<A>>;
```

## sliding

Creates a bounded `PubSub` with the sliding strategy. The `PubSub` will add new messages and drop old messages if the `PubSub` is at capacity.

Source: `effect@4.0.2/src/PubSub.ts:479`.

Vivid `PubSub.sliding` matches: 0. No qualified match. Bare-name matches: 17. Aliased usage is unverified.

```ts
export declare const sliding: <A>(capacity: number | {
    readonly capacity: number;
    readonly replay?: number | undefined;
}) => Effect.Effect<PubSub<A>>;
```

## unbounded

Creates an unbounded `PubSub`.

Source: `effect@4.0.2/src/PubSub.ts:520`.

Vivid `PubSub.unbounded` matches: 5. apps/server/src/computers/egress/relay.test.ts:130, apps/server/src/computers/screen.test.ts:60, apps/server/src/computers/store.test.ts:314 Bare-name matches: 117. Aliased usage is unverified.

```ts
export declare const unbounded: <A>(options?: {
    readonly replay?: number | undefined;
}) => Effect.Effect<PubSub<A>>;
```

## makeAtomicBounded

Creates a bounded atomic PubSub implementation with optional replay buffer.

Source: `effect@4.0.2/src/PubSub.ts:558`.

Vivid `PubSub.makeAtomicBounded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeAtomicBounded: <A>(capacity: number | {
    readonly capacity: number;
    readonly replay?: number | undefined;
}) => PubSub.Atomic<A>;
```

## makeAtomicUnbounded

Creates an unbounded atomic PubSub implementation with optional replay buffer.

Source: `effect@4.0.2/src/PubSub.ts:600`.

Vivid `PubSub.makeAtomicUnbounded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeAtomicUnbounded: <A>(options?: {
    readonly replay?: number | undefined;
}) => PubSub.Atomic<A>;
```

## capacity

Returns the number of elements the queue can hold.

Source: `effect@4.0.2/src/PubSub.ts:631`.

Vivid `PubSub.capacity` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const capacity: <A>(self: PubSub<A>) => number;
```

## size

Returns the current number of messages retained by the `PubSub` for active subscribers.

Source: `effect@4.0.2/src/PubSub.ts:672`.

Vivid `PubSub.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <A>(self: PubSub<A>) => Effect.Effect<number>;
```

## sizeUnsafe

Returns the current number of messages retained by the `PubSub` for active subscribers synchronously.

Source: `effect@4.0.2/src/PubSub.ts:705`.

Vivid `PubSub.sizeUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const sizeUnsafe: <A>(self: PubSub<A>) => number;
```

## isFull

Returns `true` when the `PubSub` has reached its configured capacity.

Source: `effect@4.0.2/src/PubSub.ts:749`.

Vivid `PubSub.isFull` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const isFull: <A>(self: PubSub<A>) => Effect.Effect<boolean>;
```

## isEmpty

Returns `true` if the `Pubsub` contains zero elements, `false` otherwise.

Source: `effect@4.0.2/src/PubSub.ts:784`.

Vivid `PubSub.isEmpty` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const isEmpty: <A>(self: PubSub<A>) => Effect.Effect<boolean>;
```

## shutdown

Shuts down the `PubSub`, interrupting suspended publishers and subscribers and finalizing active subscriptions.

Source: `effect@4.0.2/src/PubSub.ts:822`.

Vivid `PubSub.shutdown` matches: 0. No qualified match. Bare-name matches: 22. Aliased usage is unverified.

```ts
export declare const shutdown: <A>(self: PubSub<A>) => Effect.Effect<void>;
```

## end

Ends the `PubSub` with a final message.

Source: `effect@4.0.2/src/PubSub.ts:893`.

Vivid `PubSub.end` matches: 0. No qualified match. Bare-name matches: 794. Aliased usage is unverified.

```ts
export declare const end: {
    <A>(value: A): (self: PubSub<A>) => Effect.Effect<boolean>;
    <A>(self: PubSub<A>, value: A): Effect.Effect<boolean>;
};
```

## endUnsafe

Ends the `PubSub` with a final message synchronously.

Source: `effect@4.0.2/src/PubSub.ts:1031`.

Vivid `PubSub.endUnsafe` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const endUnsafe: {
    <A>(value: A): (self: PubSub<A>) => boolean;
    <A>(self: PubSub<A>, value: A): boolean;
};
```

## isShutdown

Checks effectfully whether `shutdown` has been called, returning `true` after shutdown and `false` otherwise.

Source: `effect@4.0.2/src/PubSub.ts:1109`.

Vivid `PubSub.isShutdown` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isShutdown: <A>(self: PubSub<A>) => Effect.Effect<boolean>;
```

## isShutdownUnsafe

Checks synchronously whether `shutdown` has been called, returning `true` after shutdown and `false` otherwise.

Source: `effect@4.0.2/src/PubSub.ts:1140`.

Vivid `PubSub.isShutdownUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isShutdownUnsafe: <A>(self: PubSub<A>) => boolean;
```

## awaitShutdown

Waits until the queue is shutdown. The `Effect` returned by this method will not resume until the queue has been shutdown. If the queue is already shutdown, the `Effect` will resume right away.

Source: `effect@4.0.2/src/PubSub.ts:1178`.

Vivid `PubSub.awaitShutdown` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitShutdown: <A>(self: PubSub<A>) => Effect.Effect<void>;
```

## publish

Publishes a message to the `PubSub` as an `Effect`, returning whether the message was accepted.

Source: `effect@4.0.2/src/PubSub.ts:1223`.

Vivid `PubSub.publish` matches: 6. apps/server/src/computers/egress/relay.test.ts:132, apps/server/src/computers/screen.test.ts:101, apps/server/src/computers/screen.test.ts:152 Bare-name matches: 144. Aliased usage is unverified.

```ts
export declare const publish: {
    <A>(value: A): (self: PubSub<A>) => Effect.Effect<boolean>;
    <A>(self: PubSub<A>, value: A): Effect.Effect<boolean>;
};
```

## publishUnsafe

Attempts to publish a message synchronously without applying the PubSub strategy's effectful surplus handling.

Source: `effect@4.0.2/src/PubSub.ts:1367`.

Vivid `PubSub.publishUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const publishUnsafe: {
    <A>(value: A): (self: PubSub<A>) => boolean;
    <A>(self: PubSub<A>, value: A): boolean;
};
```

## publishAll

Publishes all of the specified messages to the `PubSub`, returning whether they were published to the `PubSub`.

Source: `effect@4.0.2/src/PubSub.ts:1485`.

Vivid `PubSub.publishAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const publishAll: {
    <A>(elements: Iterable<A>): (self: PubSub<A>) => Effect.Effect<boolean>;
    <A>(self: PubSub<A>, elements: Iterable<A>): Effect.Effect<boolean>;
};
```

## subscribe

Subscribes to receive messages from the `PubSub`. The resulting subscription can be evaluated multiple times within the scope to take a message from the `PubSub` each time.

Source: `effect@4.0.2/src/PubSub.ts:1631`.

Vivid `PubSub.subscribe` matches: 8. apps/server/src/computers/egress/relay.test.ts:133, apps/server/src/computers/egress/relay.test.ts:915, apps/server/src/computers/egress/relay.test.ts:943 Bare-name matches: 144. Aliased usage is unverified.

```ts
export declare const subscribe: <A>(self: PubSub<A>) => Effect.Effect<Subscription<A>, never, Scope.Scope>;
```

## take

Takes a single message from the subscription. If no messages are available, this will suspend until a message becomes available.

Source: `effect@4.0.2/src/PubSub.ts:1699`.

Vivid `PubSub.take` matches: 1. apps/server/src/computers/egress/relay.test.ts:894 Bare-name matches: 434. Aliased usage is unverified.

```ts
export declare const take: <A>(self: Subscription<A>) => Effect.Effect<A>;
```

## takeAll

Takes all available messages from the subscription, suspending if no items are available.

Source: `effect@4.0.2/src/PubSub.ts:1748`.

Vivid `PubSub.takeAll` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const takeAll: <A>(self: Subscription<A>) => Effect.Effect<Arr.NonEmptyArray<A>>;
```

## takeUpTo

Takes up to the specified number of messages from the subscription without suspending. Finite fractional values are rounded down, while `NaN` and non-positive values are treated as `0`.

Source: `effect@4.0.2/src/PubSub.ts:1838`.

Vivid `PubSub.takeUpTo` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeUpTo: {
    (max: number): <A>(self: Subscription<A>) => Effect.Effect<Array<A>>;
    <A>(self: Subscription<A>, max: number): Effect.Effect<Array<A>>;
};
```

## takeBetween

Takes between the specified minimum and maximum number of messages from the subscription. Finite fractional bounds are rounded down, while `NaN` and non-positive bounds are treated as `0`. Will suspend if the normalized minimum number is not immediately available.

Source: `effect@4.0.2/src/PubSub.ts:1967`.

Vivid `PubSub.takeBetween` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeBetween: {
    (min: number, max: number): <A>(self: Subscription<A>) => Effect.Effect<Array<A>>;
    <A>(self: Subscription<A>, min: number, max: number): Effect.Effect<Array<A>>;
};
```

## remaining

Returns the number of messages currently available in the subscription as an `Effect`.

Source: `effect@4.0.2/src/PubSub.ts:2124`.

Vivid `PubSub.remaining` matches: 0. No qualified match. Bare-name matches: 68. Aliased usage is unverified.

```ts
export declare const remaining: <A>(self: Subscription<A>) => Effect.Effect<number>;
```

## remainingUnsafe

Synchronously returns the number of messages currently available in the subscription, or `Option.none()` when it is shut down.

Source: `effect@4.0.2/src/PubSub.ts:2161`.

Vivid `PubSub.remainingUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const remainingUnsafe: <A>(self: Subscription<A>) => Option.Option<number>;
```

## BackPressureStrategy

Represents the back-pressure strategy for bounded `PubSub` values.

Source: `effect@4.0.2/src/PubSub.ts:3080`.

Vivid `PubSub.BackPressureStrategy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class BackPressureStrategy<in out A> implements PubSub.Strategy<A> {
    publishers: MutableList.MutableList<readonly [
        A,
        Deferred.Deferred<boolean>,
        boolean
    ]>;
    get shutdown(): Effect.Effect<void>;
    handleSurplus(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>, elements: Iterable<A>, isShutdown: MutableRef.MutableRef<boolean>, ended: MutableRef.MutableRef<Option.Option<A>>): Effect.Effect<boolean>;
    onPubSubEmptySpaceUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>): void;
    completePollersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>, subscription: PubSub.BackingSubscription<A>, pollers: MutableList.MutableList<Deferred.Deferred<A>>): void;
    completeSubscribersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>): void;
    private offerUnsafe;
    removeUnsafe(deferred: Deferred.Deferred<boolean>): void;
}
```

## DroppingStrategy

Represents the dropping strategy for bounded `PubSub` values.

Source: `effect@4.0.2/src/PubSub.ts:3226`.

Vivid `PubSub.DroppingStrategy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class DroppingStrategy<in out A> implements PubSub.Strategy<A> {
    get shutdown(): Effect.Effect<void>;
    handleSurplus(_pubsub: PubSub.Atomic<A>, _subscribers: PubSub.Subscribers<A>, _elements: Iterable<A>, _isShutdown: MutableRef.MutableRef<boolean>): Effect.Effect<boolean>;
    onPubSubEmptySpaceUnsafe(_pubsub: PubSub.Atomic<A>, _subscribers: PubSub.Subscribers<A>): void;
    completePollersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>, subscription: PubSub.BackingSubscription<A>, pollers: MutableList.MutableList<Deferred.Deferred<A>>): void;
    completeSubscribersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>): void;
}
```

## SlidingStrategy

Represents the sliding strategy for bounded `PubSub` values.

Source: `effect@4.0.2/src/PubSub.ts:3310`.

Vivid `PubSub.SlidingStrategy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class SlidingStrategy<in out A> implements PubSub.Strategy<A> {
    get shutdown(): Effect.Effect<void>;
    handleSurplus(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>, elements: Iterable<A>, _isShutdown: MutableRef.MutableRef<boolean>, ended: MutableRef.MutableRef<Option.Option<A>>): Effect.Effect<boolean>;
    onPubSubEmptySpaceUnsafe(_pubsub: PubSub.Atomic<A>, _subscribers: PubSub.Subscribers<A>): void;
    completePollersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>, subscription: PubSub.BackingSubscription<A>, pollers: MutableList.MutableList<Deferred.Deferred<A>>): void;
    completeSubscribersUnsafe(pubsub: PubSub.Atomic<A>, subscribers: PubSub.Subscribers<A>): void;
    slidingPublishUnsafe(pubsub: PubSub.Atomic<A>, elements: Iterable<A>): void;
}
```
