# Queue

Import `effect/Queue`. Source `effect@4.0.2/src/Queue.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 42. Module-name matches in Vivid: 633. apps/desktop/src/main/computer.test.ts:8, apps/desktop/src/main/computer.test.ts:25, apps/desktop/src/main/computer.test.ts:28

## isQueue

Type guard to check if a value is a Queue.

Source: `effect@4.0.2/src/Queue.ts:48`.

Vivid `Queue.isQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isQueue: <A = unknown, E = unknown>(u: unknown) => u is Queue<A, E>;
```

## isEnqueue

Type guard to check if a value is an Enqueue.

Source: `effect@4.0.2/src/Queue.ts:73`.

Vivid `Queue.isEnqueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isEnqueue: <A = unknown, E = unknown>(u: unknown) => u is Enqueue<A, E>;
```

## isDequeue

Type guard to check if a value is a Dequeue.

Source: `effect@4.0.2/src/Queue.ts:94`.

Vivid `Queue.isDequeue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isDequeue: <A = unknown, E = unknown>(u: unknown) => u is Dequeue<A, E>;
```

## asEnqueue

Converts a `Queue` to its write-only `Enqueue` interface.

Source: `effect@4.0.2/src/Queue.ts:118`.

Vivid `Queue.asEnqueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const asEnqueue: <A, E>(self: Queue<A, E>) => Enqueue<A, E>;
```

## asDequeue

Narrows a `Queue` to a `Dequeue`, exposing the consumer side of the queue.

Source: `effect@4.0.2/src/Queue.ts:140`.

Vivid `Queue.asDequeue` matches: 1. apps/desktop/src/main/turn.ts:455 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const asDequeue: <A, E>(self: Queue<A, E>) => Dequeue<A, E>;
```

## Enqueue

Companion namespace containing type-level metadata for the `Enqueue` write-only queue interface.

Source: `effect@4.0.2/src/Queue.ts:192`.

Vivid `Queue.Enqueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Enqueue<in A, in E = never> extends Inspectable {
    readonly [EnqueueTypeId]: Enqueue.Variance<A, E>;
    readonly strategy: "suspend" | "dropping" | "sliding";
    readonly dispatcher: SchedulerDispatcher;
    capacity: number;
    messages: MutableList.MutableList<any>;
    state: Queue.State<any, any>;
    scheduleRunning: boolean;
}
export declare namespace Enqueue {
    interface Variance<A, E> {
        _A: Types.Contravariant<A>;
        _E: Types.Contravariant<E>;
    }
}
```

## Dequeue

Companion namespace containing type-level metadata for the `Dequeue` read-only queue interface.

Source: `effect@4.0.2/src/Queue.ts:262`.

Vivid `Queue.Dequeue` matches: 2. apps/desktop/src/main/device.ts:203, packages/client/state/src/snapshot.ts:196 Bare-name matches: 2. Aliased usage is unverified.

```ts
export interface Dequeue<out A, out E = never> extends Inspectable {
    readonly [DequeueTypeId]: Dequeue.Variance<A, E>;
    readonly strategy: "suspend" | "dropping" | "sliding";
    readonly dispatcher: SchedulerDispatcher;
    capacity: number;
    messages: MutableList.MutableList<any>;
    state: Queue.State<any, any>;
    scheduleRunning: boolean;
}
export declare namespace Dequeue {
    interface Variance<A, E> {
        _A: Types.Covariant<A>;
        _E: Types.Covariant<E>;
    }
}
```

## Queue

Companion namespace containing type-level metadata and low-level state types for `Queue`.

Source: `effect@4.0.2/src/Queue.ts:326`.

Vivid `Queue.Queue` matches: 27. apps/desktop/src/main/turn.ts:130, apps/desktop/src/main/turn.ts:131, apps/server/src/approvals/testing.ts:80 Bare-name matches: 633. Aliased usage is unverified.

```ts
export interface Queue<in out A, in out E = never> extends Enqueue<A, E>, Dequeue<A, E> {
    readonly [TypeId]: Queue.Variance<A, E>;
}
export declare namespace Queue {
    interface Variance<A, E> {
        _A: Types.Invariant<A>;
        _E: Types.Invariant<E>;
    }
    type State<A, E> = {
        readonly _tag: "Open";
        readonly takers: Set<Taker<E>>;
        readonly offers: Set<OfferEntry<A>>;
        readonly awaiters: Set<(_: Effect<void, E>) => void>;
    } | {
        readonly _tag: "Closing";
        readonly takers: Set<Taker<E>>;
        readonly offers: Set<OfferEntry<A>>;
        readonly awaiters: Set<(_: Effect<void, E>) => void>;
        readonly exit: Failure<never, E>;
    } | {
        readonly _tag: "Done";
        readonly exit: Failure<never, E>;
    };
    type OfferEntry<A> = {
        readonly _tag: "Array";
        readonly remaining: Array<A>;
        offset: number;
        readonly resume: (_: Effect<Array<A>>) => void;
    } | {
        readonly _tag: "Single";
        readonly message: A;
        readonly resume: (_: Effect<boolean>) => void;
    };
    interface Taker<E> {
        readonly ready: () => boolean;
        readonly resume: (_: Effect<void, E>) => void;
    }
}
```

## make

Creates a `Queue` with optional capacity and overflow strategy.

Source: `effect@4.0.2/src/Queue.ts:480`.

Vivid `Queue.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A, E = never>(options?: {
    readonly capacity?: number | undefined;
    readonly strategy?: "suspend" | "dropping" | "sliding" | undefined;
} | undefined) => Effect<Queue<A, E>>;
```

## bounded

Creates a bounded queue with the specified capacity that uses backpressure strategy.

Source: `effect@4.0.2/src/Queue.ts:533`.

Vivid `Queue.bounded` matches: 0. No qualified match. Bare-name matches: 110. Aliased usage is unverified.

```ts
export declare const bounded: <A, E = never>(capacity: number) => Effect<Queue<A, E>>;
```

## sliding

Creates a bounded queue with sliding strategy. When the queue reaches capacity, new elements are added and the oldest elements are dropped.

Source: `effect@4.0.2/src/Queue.ts:571`.

Vivid `Queue.sliding` matches: 4. apps/desktop/src/main/device.ts:244, apps/desktop/src/main/egress.ts:758, apps/server/src/computers/egress/relay.ts:406 Bare-name matches: 17. Aliased usage is unverified.

```ts
export declare const sliding: <A, E = never>(capacity: number) => Effect<Queue<A, E>>;
```

## dropping

Creates a bounded queue with dropping strategy. When the queue reaches capacity, new elements are dropped and the offer operation returns false.

Source: `effect@4.0.2/src/Queue.ts:608`.

Vivid `Queue.dropping` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const dropping: <A, E = never>(capacity: number) => Effect<Queue<A, E>>;
```

## unbounded

Creates an unbounded queue that can grow to any size without blocking producers.

Source: `effect@4.0.2/src/Queue.ts:647`.

Vivid `Queue.unbounded` matches: 92. apps/desktop/src/main/computer.test.ts:25, apps/desktop/src/main/computer.ts:317, apps/desktop/src/main/egress.test.ts:193 Bare-name matches: 117. Aliased usage is unverified.

```ts
export declare const unbounded: <A, E = never>() => Effect<Queue<A, E>>;
```

## offer

Adds a message to the queue. Returns `false` if the queue is done.

Source: `effect@4.0.2/src/Queue.ts:682`.

Vivid `Queue.offer` matches: 87. apps/desktop/src/main/signin.test.ts:29, apps/server/src/approvals/testing.ts:154, apps/server/src/auth/middleware.test.ts:102 Bare-name matches: 195. Aliased usage is unverified.

```ts
export declare const offer: {
    <A>(message: A): <E>(self: Enqueue<A, E>) => Effect<boolean>;
    <A, E>(self: Enqueue<A, E>, message: Types.NoInfer<A>): Effect<boolean>;
};
```

## offerUnsafe

Adds a message to the queue synchronously. Returns `false` if the queue is done.

Source: `effect@4.0.2/src/Queue.ts:801`.

Vivid `Queue.offerUnsafe` matches: 40. apps/desktop/src/main/computer.test.ts:28, apps/desktop/src/main/computer.test.ts:31, apps/desktop/src/main/computer.ts:345 Bare-name matches: 40. Aliased usage is unverified.

```ts
export declare const offerUnsafe: <A, E>(self: Enqueue<A, E>, message: Types.NoInfer<A>) => boolean;
```

## offerAll

Adds multiple messages to the queue. Returns the remaining messages that were not added.

Source: `effect@4.0.2/src/Queue.ts:856`.

Vivid `Queue.offerAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const offerAll: {
    <A>(messages: Iterable<A>): <E>(self: Enqueue<A, E>) => Effect<Array<A>>;
    <A, E>(self: Enqueue<A, E>, messages: Iterable<A>): Effect<Array<A>>;
};
```

## offerAllUnsafe

Adds multiple messages to the queue synchronously. Returns the remaining messages that were not added.

Source: `effect@4.0.2/src/Queue.ts:1012`.

Vivid `Queue.offerAllUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const offerAllUnsafe: <A, E>(self: Enqueue<A, E>, messages: Iterable<A>) => Array<A>;
```

## fail

Fails the queue with an error. If the queue is already done, `false` is returned.

Source: `effect@4.0.2/src/Queue.ts:1073`.

Vivid `Queue.fail` matches: 1. apps/server/src/code/computer.ts:139 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: {
    <E>(error: E): <A>(self: Enqueue<A, E>) => Effect<boolean>;
    <A, E>(self: Enqueue<A, E>, error: E): Effect<boolean>;
};
```

## failCause

Fails the queue with a cause. If the queue is already done, `false` is returned.

Source: `effect@4.0.2/src/Queue.ts:1160`.

Vivid `Queue.failCause` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const failCause: {
    <E>(cause: Cause<E>): <A>(self: Enqueue<A, E>) => Effect<boolean>;
    <A, E>(self: Enqueue<A, E>, cause: Cause<E>): Effect<boolean>;
};
```

## failCauseUnsafe

Fails the queue with a cause synchronously. If the queue is already done, `false` is returned.

Source: `effect@4.0.2/src/Queue.ts:1262`.

Vivid `Queue.failCauseUnsafe` matches: 2. apps/server/src/code/testing.ts:41, apps/server/src/computers/ssh/link.ts:548 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const failCauseUnsafe: <A, E>(self: Enqueue<A, E>, cause: Cause<E>) => boolean;
```

## end

Signals queue completion.

Source: `effect@4.0.2/src/Queue.ts:1323`.

Vivid `Queue.end` matches: 0. No qualified match. Bare-name matches: 794. Aliased usage is unverified.

```ts
export declare const end: <A, E>(self: Enqueue<A, E | Done>) => Effect<boolean>;
```

## endUnsafe

Signals queue completion synchronously.

Source: `effect@4.0.2/src/Queue.ts:1375`.

Vivid `Queue.endUnsafe` matches: 4. apps/server/src/code/testing.ts:45, apps/server/src/computers/egress/proxy.test.ts:115, apps/server/src/computers/egress/relay.ts:279 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const endUnsafe: <A, E>(self: Enqueue<A, E | Done>) => boolean;
```

## interrupt

Interrupts the queue gracefully, transitioning it to a closing state.

Source: `effect@4.0.2/src/Queue.ts:1420`.

Vivid `Queue.interrupt` matches: 0. No qualified match. Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const interrupt: <A, E>(self: Enqueue<A, E>) => Effect<boolean>;
```

## shutdown

Shuts down the queue immediately, discarding buffered messages and resuming pending operations.

Source: `effect@4.0.2/src/Queue.ts:1460`.

Vivid `Queue.shutdown` matches: 0. No qualified match. Bare-name matches: 22. Aliased usage is unverified.

```ts
export declare const shutdown: <A, E>(self: Enqueue<A, E>) => Effect<boolean>;
```

## shutdownUnsafe

Shuts down the queue synchronously, discarding buffered messages and resuming pending operations.

Source: `effect@4.0.2/src/Queue.ts:1484`.

Vivid `Queue.shutdownUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const shutdownUnsafe: <A, E>(self: Enqueue<A, E>) => boolean;
```

## clear

Takes and returns all currently buffered messages without waiting for more.

Source: `effect@4.0.2/src/Queue.ts:1534`.

Vivid `Queue.clear` matches: 10. apps/server/src/computers/boat.test.ts:2096, apps/server/src/computers/boat.test.ts:2121, apps/server/src/computers/boat.test.ts:2146 Bare-name matches: 107. Aliased usage is unverified.

```ts
export declare const clear: <A, E>(self: Dequeue<A, E>) => Effect<Array<A>, Pull.ExcludeDone<E>>;
```

## takeAll

Takes all currently available messages, waiting until at least one message is available when the queue is empty.

Source: `effect@4.0.2/src/Queue.ts:1581`.

Vivid `Queue.takeAll` matches: 2. apps/server/src/computers/device.test.ts:451, apps/server/src/watches/lifecycle.test.ts:199 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const takeAll: <A, E>(self: Dequeue<A, E>) => Effect<Arr.NonEmptyArray<A>, E>;
```

## collect

Takes all messages from the queue, until the queue has errored or is done.

Source: `effect@4.0.2/src/Queue.ts:1610`.

Vivid `Queue.collect` matches: 0. No qualified match. Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const collect: <A, E>(self: Dequeue<A, E | Done>) => Effect<Array<A>, Pull.ExcludeDone<E>>;
```

## takeN

Takes up to `n` messages from the queue.

Source: `effect@4.0.2/src/Queue.ts:1671`.

Vivid `Queue.takeN` matches: 3. apps/server/src/observability/export.test.ts:1259, apps/server/src/observability/export.test.ts:1325, apps/server/src/observability/export.test.ts:1334 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const takeN: {
    (n: number): <A, E>(self: Dequeue<A, E>) => Effect<Array<A>, E>;
    <A, E>(self: Dequeue<A, E>, n: number): Effect<Array<A>, E>;
};
```

## takeBetween

Takes between `min` and `max` messages from the queue.

Source: `effect@4.0.2/src/Queue.ts:1799`.

Vivid `Queue.takeBetween` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeBetween: {
    (min: number, max: number): <A, E>(self: Dequeue<A, E>) => Effect<Array<A>, E>;
    <A, E>(self: Dequeue<A, E>, min: number, max: number): Effect<Array<A>, E>;
};
```

## take

Takes a single message from the queue, or wait for a message to be available.

Source: `effect@4.0.2/src/Queue.ts:1933`.

Vivid `Queue.take` matches: 232. apps/desktop/src/main/computer.test.ts:180, apps/desktop/src/main/computer.test.ts:181, apps/desktop/src/main/computer.test.ts:188 Bare-name matches: 434. Aliased usage is unverified.

```ts
export declare const take: <A, E>(self: Dequeue<A, E>) => Effect<A, E>;
```

## poll

Attempts to take one item from the queue without waiting.

Source: `effect@4.0.2/src/Queue.ts:1971`.

Vivid `Queue.poll` matches: 3. apps/server/src/computers/store.test.ts:1383, apps/server/src/computers/store.test.ts:2139, packages/client/state/src/snapshot.ts:201 Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const poll: <A, E>(self: Dequeue<A, E>) => Effect<Option.Option<A>>;
```

## peek

Peeks at the next item without removing it.

Source: `effect@4.0.2/src/Queue.ts:2011`.

Vivid `Queue.peek` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const peek: <A, E>(self: Dequeue<A, E>) => Effect<A, E>;
```

## takeUnsafe

Attempts to take one message from the queue synchronously.

Source: `effect@4.0.2/src/Queue.ts:2067`.

Vivid `Queue.takeUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeUnsafe: <A, E>(self: Dequeue<A, E>) => Exit<A, E> | undefined;
```

## flushUnsafe

Manually releases current queue takers synchronously.

Source: `effect@4.0.2/src/Queue.ts:2120`.

Vivid `Queue.flushUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const flushUnsafe: <A, E>(self: Enqueue<A, E>) => void;
```

## flush

Manually releases current queue takers.

Source: `effect@4.0.2/src/Queue.ts:2159`.

Vivid `Queue.flush` matches: 0. No qualified match. Bare-name matches: 70. Aliased usage is unverified.

```ts
export declare const flush: <A, E>(self: Enqueue<A, E>) => Effect<void>;
```

## await

Waits until a queue reaches the `Done` state.

Source: `effect@4.0.2/src/Queue.ts:2205`.

Vivid `Queue.await` matches: 0. No qualified match. Bare-name matches: 395. Aliased usage is unverified.

```ts
declare const await_: <A, E>(self: Dequeue<A, E>) => Effect<void, Exclude<E, Done>>;
export { await_ as await };
```

## size

Returns the current number of buffered messages in the queue.

Source: `effect@4.0.2/src/Queue.ts:2249`.

Vivid `Queue.size` matches: 66. apps/desktop/src/main/egress.test.ts:781, apps/desktop/src/main/egress.test.ts:968, apps/server/src/computers/device.test.ts:535 Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <A, E>(self: Dequeue<A, E>) => Effect<number>;
```

## isFull

Checks whether the queue is full.

Source: `effect@4.0.2/src/Queue.ts:2278`.

Vivid `Queue.isFull` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const isFull: <A, E>(self: Dequeue<A, E>) => Effect<boolean>;
```

## sizeUnsafe

Returns the current number of buffered messages in the queue synchronously.

Source: `effect@4.0.2/src/Queue.ts:2329`.

Vivid `Queue.sizeUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const sizeUnsafe: <A, E>(self: Dequeue<A, E>) => number;
```

## isFullUnsafe

Checks whether the queue is full synchronously.

Source: `effect@4.0.2/src/Queue.ts:2363`.

Vivid `Queue.isFullUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isFullUnsafe: <A, E>(self: Dequeue<A, E>) => boolean;
```

## into

Runs an `Effect` into a `Queue`, where success ends the queue and failure fails the queue.

Source: `effect@4.0.2/src/Queue.ts:2400`.

Vivid `Queue.into` matches: 0. No qualified match. Bare-name matches: 417. Aliased usage is unverified.

```ts
export declare const into: {
    <A, E>(self: Enqueue<A, E | Done>): <AX, EX extends E, RX>(effect: Effect<AX, EX, RX>) => Effect<boolean, never, RX>;
    <AX, E, EX extends E, RX, A>(effect: Effect<AX, EX, RX>, self: Enqueue<A, E | Done>): Effect<boolean, never, RX>;
};
```
