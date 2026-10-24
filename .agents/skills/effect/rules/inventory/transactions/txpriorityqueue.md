# TxPriorityQueue

Import `effect/TxPriorityQueue`. Source `effect@4.0.2/src/TxPriorityQueue.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 19. Module-name matches in Vivid: 0. No bare-name match.

## TxPriorityQueue

A transactional priority queue backed by a sorted `Chunk`.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:61`.

Vivid `TxPriorityQueue.TxPriorityQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TxPriorityQueue<in out A> extends Inspectable, Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly ref: TxRef.TxRef<Chunk<A>>;
    readonly ord: Order<A>;
}
```

## empty

Creates an empty `TxPriorityQueue` with the given ordering.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:145`.

Vivid `TxPriorityQueue.empty` matches: 0. No qualified match. Bare-name matches: 378. Aliased usage is unverified.

```ts
export declare const empty: <A>(order: Order<A>) => Effect.Effect<TxPriorityQueue<A>>;
```

## fromIterable

Creates a `TxPriorityQueue` from an iterable of elements.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:168`.

Vivid `TxPriorityQueue.fromIterable` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare function fromIterable<A>(order: Order<A>): (iterable: Iterable<A>) => Effect.Effect<TxPriorityQueue<A>>;
export declare function fromIterable<A>(order: Order<A>, iterable: Iterable<A>): Effect.Effect<TxPriorityQueue<A>>;
```

## make

Creates a `TxPriorityQueue` from variadic elements.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:209`.

Vivid `TxPriorityQueue.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(order: Order<A>) => (...elements: Array<A>) => Effect.Effect<TxPriorityQueue<A>>;
```

## size

Returns the number of elements in the queue.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:232`.

Vivid `TxPriorityQueue.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <A>(self: TxPriorityQueue<A>) => Effect.Effect<number>;
```

## isEmpty

Returns `true` if the queue is empty.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:254`.

Vivid `TxPriorityQueue.isEmpty` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const isEmpty: <A>(self: TxPriorityQueue<A>) => Effect.Effect<boolean>;
```

## isNonEmpty

Returns `true` if the queue has at least one element.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:276`.

Vivid `TxPriorityQueue.isNonEmpty` matches: 0. No qualified match. Bare-name matches: 63. Aliased usage is unverified.

```ts
export declare const isNonEmpty: <A>(self: TxPriorityQueue<A>) => Effect.Effect<boolean>;
```

## peek

Observes the smallest element without removing it.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:303`.

Vivid `TxPriorityQueue.peek` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const peek: <A>(self: TxPriorityQueue<A>) => Effect.Effect<A>;
```

## peekOption

Observes the smallest element without removing it, returning `None` when the queue is empty.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:338`.

Vivid `TxPriorityQueue.peekOption` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const peekOption: <A>(self: TxPriorityQueue<A>) => Effect.Effect<Option<A>>;
```

## offer

Inserts an element into the queue in sorted position.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:363`.

Vivid `TxPriorityQueue.offer` matches: 0. No qualified match. Bare-name matches: 195. Aliased usage is unverified.

```ts
export declare const offer: {
    <A>(value: A): (self: TxPriorityQueue<A>) => Effect.Effect<void>;
    <A>(self: TxPriorityQueue<A>, value: A): Effect.Effect<void>;
};
```

## offerAll

Inserts all elements from an iterable into the queue.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:437`.

Vivid `TxPriorityQueue.offerAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const offerAll: {
    <A>(values: Iterable<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>;
    <A>(self: TxPriorityQueue<A>, values: Iterable<A>): Effect.Effect<void>;
};
```

## take

Takes the smallest element from the queue. Retries if the queue is empty.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:510`.

Vivid `TxPriorityQueue.take` matches: 0. No qualified match. Bare-name matches: 434. Aliased usage is unverified.

```ts
export declare const take: <A>(self: TxPriorityQueue<A>) => Effect.Effect<A>;
```

## takeAll

Takes all elements from the queue, returning them in priority order.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:541`.

Vivid `TxPriorityQueue.takeAll` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const takeAll: <A>(self: TxPriorityQueue<A>) => Effect.Effect<Array<A>>;
```

## takeOption

Tries to take the smallest element. Returns `None` if the queue is empty.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:567`.

Vivid `TxPriorityQueue.takeOption` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeOption: <A>(self: TxPriorityQueue<A>) => Effect.Effect<Option<A>>;
```

## takeUpTo

Takes up to `n` elements from the queue in priority order.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:596`.

Vivid `TxPriorityQueue.takeUpTo` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeUpTo: {
    (n: number): <A>(self: TxPriorityQueue<A>) => Effect.Effect<Array<A>>;
    <A>(self: TxPriorityQueue<A>, n: number): Effect.Effect<Array<A>>;
};
```

## removeIf

Removes elements matching the predicate.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:673`.

Vivid `TxPriorityQueue.removeIf` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const removeIf: {
    <A>(predicate: Predicate<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>;
    <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void>;
};
```

## retainIf

Keeps only elements matching the predicate.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:745`.

Vivid `TxPriorityQueue.retainIf` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const retainIf: {
    <A>(predicate: Predicate<A>): (self: TxPriorityQueue<A>) => Effect.Effect<void>;
    <A>(self: TxPriorityQueue<A>, predicate: Predicate<A>): Effect.Effect<void>;
};
```

## toArray

Returns all elements in priority order without removing them.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:816`.

Vivid `TxPriorityQueue.toArray` matches: 0. No qualified match. Bare-name matches: 39. Aliased usage is unverified.

```ts
export declare const toArray: <A>(self: TxPriorityQueue<A>) => Effect.Effect<Array<A>>;
```

## isTxPriorityQueue

Determines if the provided value is a `TxPriorityQueue`.

Source: `effect@4.0.2/src/TxPriorityQueue.ts:839`.

Vivid `TxPriorityQueue.isTxPriorityQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxPriorityQueue: (u: unknown) => u is TxPriorityQueue<unknown>;
```
