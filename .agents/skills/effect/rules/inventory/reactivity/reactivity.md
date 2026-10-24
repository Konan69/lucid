# Reactivity

Import `effect/reactivity/Reactivity`. Source `effect@4.0.2/src/reactivity/Reactivity.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 8. Module-name matches in Vivid: 0. No bare-name match.

## TypeId

Brand for `Reactivity` implementations.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:41`.

Vivid `Reactivity.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type TypeId = "~effect/reactivity/Reactivity";
export declare const TypeId: TypeId;
```

## Reactivity

Service key for reactive invalidation.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:82`.

Vivid `Reactivity.Reactivity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Reactivity {
    readonly [TypeId]: TypeId;
    readonly invalidateUnsafe: (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>) => void;
    readonly registerUnsafe: (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>, handler: () => void) => () => void;
    readonly invalidate: (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>) => Effect.Effect<void>;
    readonly mutation: <A, E, R>(keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly query: <A, E, R>(keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>, effect: Effect.Effect<A, E, R>) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope>;
    readonly stream: <A, E, R>(keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>, effect: Effect.Effect<A, E, R>) => Stream.Stream<A, E, Exclude<R, Scope.Scope>>;
    readonly withBatch: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
export declare const Reactivity: Context.Service<Reactivity, Reactivity>;
```

## make

Creates an in-memory `Reactivity` service.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:96`.

Vivid `Reactivity.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: Effect.Effect<Reactivity, never, never>;
```

## mutation

Wraps an effect so the supplied keys are invalidated after the effect succeeds.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:248`.

Vivid `Reactivity.mutation` matches: 0. No qualified match. Bare-name matches: 59. Aliased usage is unverified.

```ts
export declare const mutation: {
    (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Reactivity>;
    <A, E, R>(effect: Effect.Effect<A, E, R>, keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>): Effect.Effect<A, E, R | Reactivity>;
};
```

## query

Runs an effect as a query tied to the supplied invalidation keys.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:295`.

Vivid `Reactivity.query` matches: 0. No qualified match. Bare-name matches: 747. Aliased usage is unverified.

```ts
export declare const query: {
    (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope | Reactivity>;
    <A, E, R>(effect: Effect.Effect<A, E, R>, keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>): Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope | Reactivity>;
};
```

## stream

Runs an effect as a stream of query results tied to the supplied invalidation keys.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:347`.

Vivid `Reactivity.stream` matches: 0. No qualified match. Bare-name matches: 649. Aliased usage is unverified.

```ts
export declare const stream: {
    (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>): <A, E, R>(effect: Effect.Effect<A, E, R>) => Stream.Stream<A, E, Exclude<R, Scope.Scope> | Reactivity>;
    <A, E, R>(effect: Effect.Effect<A, E, R>, keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>): Stream.Stream<A, E, Exclude<R, Scope.Scope> | Reactivity>;
};
```

## invalidate

Invalidates the supplied keys through the `Reactivity` service.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:400`.

Vivid `Reactivity.invalidate` matches: 0. No qualified match. Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const invalidate: (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>) => Effect.Effect<void, never, Reactivity>;
```

## layer

The default layer that provides an in-memory `Reactivity` service.

Source: `effect@4.0.2/src/reactivity/Reactivity.ts:411`.

Vivid `Reactivity.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<Reactivity>;
```
