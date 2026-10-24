# TxQueue

Import `effect/TxQueue`. Source `effect@4.0.2/src/TxQueue.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 35. Module-name matches in Vivid: 0. No bare-name match.

## State

Represents the state of a transactional queue with sophisticated lifecycle management.

Source: `effect@4.0.2/src/TxQueue.ts:52`.

Vivid `TxQueue.State` matches: 0. No qualified match. Bare-name matches: 50. Aliased usage is unverified.

```ts
export type State<_A, E> = {
    readonly _tag: "Open";
} | {
    readonly _tag: "Closing";
    readonly cause: Cause.Cause<E>;
} | {
    readonly _tag: "Done";
    readonly cause: Cause.Cause<E>;
};
```

## TxEnqueue

A TxEnqueue represents the write-only interface of a transactional queue, providing operations for adding elements (enqueue operations) and inspecting queue state.

Source: `effect@4.0.2/src/TxQueue.ts:180`.

Vivid `TxQueue.TxEnqueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare namespace TxEnqueue {
    interface Variance<in A, in E> {
        readonly _A: Types.Contravariant<A>;
        readonly _E: Types.Contravariant<E>;
    }
}
export interface TxEnqueue<in A, in E = never> extends TxQueueState {
    readonly [EnqueueTypeId]: TxEnqueue.Variance<A, E>;
}
```

## TxDequeue

A TxDequeue represents the read-only interface of a transactional queue, providing operations for consuming elements (dequeue operations) and inspecting queue state.

Source: `effect@4.0.2/src/TxQueue.ts:216`.

Vivid `TxQueue.TxDequeue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare namespace TxDequeue {
    interface Variance<out A, out E> {
        readonly _A: Types.Covariant<A>;
        readonly _E: Types.Covariant<E>;
    }
}
export interface TxDequeue<out A, out E = never> extends TxQueueState {
    readonly [DequeueTypeId]: TxDequeue.Variance<A, E>;
}
```

## TxQueue

A TxQueue represents a transactional queue data structure that provides both enqueue and dequeue operations with Software Transactional Memory (STM) semantics.

Source: `effect@4.0.2/src/TxQueue.ts:253`.

Vivid `TxQueue.TxQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare namespace TxQueue {
    interface Variance<in out A, in out E> {
        readonly _A: Types.Invariant<A>;
        readonly _E: Types.Invariant<E>;
    }
}
export interface TxQueue<in out A, in out E = never> extends TxEnqueue<A, E>, TxDequeue<A, E> {
    readonly [TypeId]: TxQueue.Variance<A, E>;
}
```

## TxQueueState

Represents the shared state of a transactional queue that can be inspected. This interface contains the core properties needed for queue state inspection operations like size, capacity, and completion status.

Source: `effect@4.0.2/src/TxQueue.ts:135`.

Vivid `TxQueue.TxQueueState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TxQueueState extends Inspectable {
    readonly strategy: "bounded" | "unbounded" | "dropping" | "sliding";
    readonly capacity: number;
    readonly items: TxChunk.TxChunk<any>;
    readonly stateRef: TxRef.TxRef<State<any, any>>;
}
```

## isTxEnqueue

Checks whether the given value is a TxEnqueue.

Source: `effect@4.0.2/src/TxQueue.ts:273`.

Vivid `TxQueue.isTxEnqueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxEnqueue: <A = unknown, E = unknown>(u: unknown) => u is TxEnqueue<A, E>;
```

## isTxDequeue

Checks whether the given value is a TxDequeue.

Source: `effect@4.0.2/src/TxQueue.ts:291`.

Vivid `TxQueue.isTxDequeue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxDequeue: <A = unknown, E = unknown>(u: unknown) => u is TxDequeue<A, E>;
```

## isTxQueue

Checks whether the given value is a TxQueue.

Source: `effect@4.0.2/src/TxQueue.ts:309`.

Vivid `TxQueue.isTxQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxQueue: <A = unknown, E = unknown>(u: unknown) => u is TxQueue<A, E>;
```

## bounded

Creates a new bounded `TxQueue` with the specified capacity.

Source: `effect@4.0.2/src/TxQueue.ts:371`.

Vivid `TxQueue.bounded` matches: 0. No qualified match. Bare-name matches: 110. Aliased usage is unverified.

```ts
export declare const bounded: <A = never, E = never>(capacity: number) => Effect.Effect<TxQueue<A, E>>;
```

## unbounded

Creates a new unbounded `TxQueue` with unlimited capacity.

Source: `effect@4.0.2/src/TxQueue.ts:419`.

Vivid `TxQueue.unbounded` matches: 0. No qualified match. Bare-name matches: 117. Aliased usage is unverified.

```ts
export declare const unbounded: <A = never, E = never>() => Effect.Effect<TxQueue<A, E>>;
```

## dropping

Creates a new dropping `TxQueue` with the specified capacity that drops new items when full.

Source: `effect@4.0.2/src/TxQueue.ts:463`.

Vivid `TxQueue.dropping` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const dropping: <A = never, E = never>(capacity: number) => Effect.Effect<TxQueue<A, E>>;
```

## sliding

Creates a new sliding `TxQueue` with the specified capacity that evicts old items when full.

Source: `effect@4.0.2/src/TxQueue.ts:511`.

Vivid `TxQueue.sliding` matches: 0. No qualified match. Bare-name matches: 17. Aliased usage is unverified.

```ts
export declare const sliding: <A = never, E = never>(capacity: number) => Effect.Effect<TxQueue<A, E>>;
```

## offer

Offers an item to the queue and returns whether it was accepted.

Source: `effect@4.0.2/src/TxQueue.ts:556`.

Vivid `TxQueue.offer` matches: 0. No qualified match. Bare-name matches: 195. Aliased usage is unverified.

```ts
export declare const offer: {
    <A, E>(value: A): (self: TxEnqueue<A, E>) => Effect.Effect<boolean>;
    <A, E>(self: TxEnqueue<A, E>, value: A): Effect.Effect<boolean>;
};
```

## offerAll

Offers multiple items to the queue, returning the items that were not accepted.

Source: `effect@4.0.2/src/TxQueue.ts:685`.

Vivid `TxQueue.offerAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const offerAll: {
    <A, E>(values: Iterable<A>): (self: TxEnqueue<A, E>) => Effect.Effect<Array<A>>;
    <A, E>(self: TxEnqueue<A, E>, values: Iterable<A>): Effect.Effect<Array<A>>;
};
```

## take

Takes the next item from the queue, retrying the transaction while the queue is empty.

Source: `effect@4.0.2/src/TxQueue.ts:795`.

Vivid `TxQueue.take` matches: 0. No qualified match. Bare-name matches: 434. Aliased usage is unverified.

```ts
export declare const take: <A, E>(self: TxDequeue<A, E>) => Effect.Effect<A, E>;
```

## poll

Tries to take an item from the queue without blocking.

Source: `effect@4.0.2/src/TxQueue.ts:852`.

Vivid `TxQueue.poll` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const poll: <A, E>(self: TxDequeue<A, E>) => Effect.Effect<Option.Option<A>>;
```

## takeAll

Takes all items from the queue. Blocks if the queue is empty.

Source: `effect@4.0.2/src/TxQueue.ts:912`.

Vivid `TxQueue.takeAll` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const takeAll: <A, E>(self: TxDequeue<A, E>) => Effect.Effect<Arr.NonEmptyArray<A>, E>;
```

## takeN

Takes up to `n` items from the queue in a single transaction.

Source: `effect@4.0.2/src/TxQueue.ts:971`.

Vivid `TxQueue.takeN` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const takeN: {
    (n: number): <A, E>(self: TxDequeue<A, E>) => Effect.Effect<Array<A>, E>;
    <A, E>(self: TxDequeue<A, E>, n: number): Effect.Effect<Array<A>, E>;
};
```

## takeBetween

Takes between `min` and `max` currently available items, waiting for `min` on an open queue.

Source: `effect@4.0.2/src/TxQueue.ts:1129`.

Vivid `TxQueue.takeBetween` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeBetween: {
    (min: number, max: number): <A, E>(self: TxDequeue<A, E>) => Effect.Effect<Array<A>, E>;
    <A, E>(self: TxDequeue<A, E>, min: number, max: number): Effect.Effect<Array<A>, E>;
};
```

## peek

Waits transactionally for the next item and returns it without removing it.

Source: `effect@4.0.2/src/TxQueue.ts:1299`.

Vivid `TxQueue.peek` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const peek: <A, E>(self: TxDequeue<A, E>) => Effect.Effect<A, E>;
```

## size

Gets the current size of the queue.

Source: `effect@4.0.2/src/TxQueue.ts:1337`.

Vivid `TxQueue.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: (self: TxQueueState) => Effect.Effect<number>;
```

## isEmpty

Checks whether the queue is empty.

Source: `effect@4.0.2/src/TxQueue.ts:1364`.

Vivid `TxQueue.isEmpty` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const isEmpty: (self: TxQueueState) => Effect.Effect<boolean>;
```

## isNonEmpty

Checks whether the queue is non-empty.

Source: `effect@4.0.2/src/TxQueue.ts:1391`.

Vivid `TxQueue.isNonEmpty` matches: 0. No qualified match. Bare-name matches: 63. Aliased usage is unverified.

```ts
export declare const isNonEmpty: (self: TxQueueState) => Effect.Effect<boolean>;
```

## isFull

Checks whether the queue is at capacity.

Source: `effect@4.0.2/src/TxQueue.ts:1418`.

Vivid `TxQueue.isFull` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const isFull: (self: TxQueueState) => Effect.Effect<boolean>;
```

## interrupt

Interrupts the queue gracefully with the current fiber's interruption cause.

Source: `effect@4.0.2/src/TxQueue.ts:1450`.

Vivid `TxQueue.interrupt` matches: 0. No qualified match. Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const interrupt: <A, E>(self: TxEnqueue<A, E>) => Effect.Effect<boolean>;
```

## fail

Fails the queue with the specified error, discarding any buffered items.

Source: `effect@4.0.2/src/TxQueue.ts:1479`.

Vivid `TxQueue.fail` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: {
    <E>(error: E): <A>(self: TxEnqueue<A, E>) => Effect.Effect<boolean>;
    <A, E>(self: TxEnqueue<A, E>, error: E): Effect.Effect<boolean>;
};
```

## failCause

Completes the queue with the specified cause.

Source: `effect@4.0.2/src/TxQueue.ts:1580`.

Vivid `TxQueue.failCause` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const failCause: {
    <E>(cause: Cause.Cause<E>): <A>(self: TxEnqueue<A, E>) => Effect.Effect<boolean>;
    <A, E>(self: TxEnqueue<A, E>, cause: Cause.Cause<E>): Effect.Effect<boolean>;
};
```

## end

Ends a queue by signaling completion with a `Cause.Done` error.

Source: `effect@4.0.2/src/TxQueue.ts:1693`.

Vivid `TxQueue.end` matches: 0. No qualified match. Bare-name matches: 794. Aliased usage is unverified.

```ts
export declare const end: <A, E>(self: TxEnqueue<A, E | Cause.Done>) => Effect.Effect<boolean>;
```

## clear

Removes and returns all currently buffered elements.

Source: `effect@4.0.2/src/TxQueue.ts:1727`.

Vivid `TxQueue.clear` matches: 0. No qualified match. Bare-name matches: 107. Aliased usage is unverified.

```ts
export declare const clear: <A, E>(self: TxEnqueue<A, E>) => Effect.Effect<Array<A>, ExcludeDone<E>>;
```

## shutdown

Shuts down the queue immediately by clearing all items and interrupting it (legacy compatibility).

Source: `effect@4.0.2/src/TxQueue.ts:1778`.

Vivid `TxQueue.shutdown` matches: 0. No qualified match. Bare-name matches: 22. Aliased usage is unverified.

```ts
export declare const shutdown: <A, E>(self: TxEnqueue<A, E>) => Effect.Effect<boolean>;
```

## isOpen

Checks whether the queue is in the open state.

Source: `effect@4.0.2/src/TxQueue.ts:1809`.

Vivid `TxQueue.isOpen` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isOpen: (self: TxQueueState) => Effect.Effect<boolean>;
```

## isClosing

Checks whether the queue is in the closing state.

Source: `effect@4.0.2/src/TxQueue.ts:1838`.

Vivid `TxQueue.isClosing` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isClosing: (self: TxQueueState) => Effect.Effect<boolean>;
```

## isDone

Checks whether the queue is done (completed or failed).

Source: `effect@4.0.2/src/TxQueue.ts:1866`.

Vivid `TxQueue.isDone` matches: 0. No qualified match. Bare-name matches: 22. Aliased usage is unverified.

```ts
export declare const isDone: (self: TxQueueState) => Effect.Effect<boolean>;
```

## isShutdown

Checks whether the queue is shutdown (legacy compatibility).

Source: `effect@4.0.2/src/TxQueue.ts:1894`.

Vivid `TxQueue.isShutdown` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isShutdown: (self: TxQueueState) => Effect.Effect<boolean>;
```

## awaitCompletion

Waits for the queue to complete (either successfully or with failure).

Source: `effect@4.0.2/src/TxQueue.ts:1921`.

Vivid `TxQueue.awaitCompletion` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitCompletion: (self: TxQueueState) => Effect.Effect<void>;
```
