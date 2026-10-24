# FiberSet

Import `effect/FiberSet`. Source `effect@4.0.2/src/FiberSet.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 14. Module-name matches in Vivid: 2. apps/desktop/src/main/egress.ts:21, apps/desktop/src/main/egress.ts:648

## FiberSet

A FiberSet is a collection of fibers that can be managed together. When the associated Scope is closed, all fibers in the set will be interrupted.

Source: `effect@4.0.2/src/FiberSet.ts:58`.

Vivid `FiberSet.FiberSet` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export interface FiberSet<out A = unknown, out E = unknown> extends Pipeable, Inspectable.Inspectable, Iterable<Fiber.Fiber<A, E>> {
    readonly [TypeId]: typeof TypeId;
    readonly deferred: Deferred.Deferred<void, unknown>;
    state: {
        readonly _tag: "Open";
        readonly backing: Set<Fiber.Fiber<A, E>>;
    } | {
        readonly _tag: "Closed";
    };
}
```

## isFiberSet

Checks whether a value is a FiberSet.

Source: `effect@4.0.2/src/FiberSet.ts:93`.

Vivid `FiberSet.isFiberSet` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isFiberSet: (u: unknown) => u is FiberSet<unknown, unknown>;
```

## make

Creates a scoped `FiberSet` for storing fibers.

Source: `effect@4.0.2/src/FiberSet.ts:158`.

Vivid `FiberSet.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A = unknown, E = unknown>() => Effect.Effect<FiberSet<A, E>, never, Scope.Scope>;
```

## makeRuntime

Creates a scoped run function that forks effects into a new `FiberSet`.

Source: `effect@4.0.2/src/FiberSet.ts:204`.

Vivid `FiberSet.makeRuntime` matches: 1. apps/desktop/src/main/egress.ts:648 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const makeRuntime: <R = never, A = unknown, E = unknown>() => Effect.Effect<(<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly propagateInterruption?: boolean | undefined;
}) | undefined) => Fiber.Fiber<XA, XE>), never, Scope.Scope | R>;
```

## makeRuntimePromise

Creates a scoped run function that forks effects into a new `FiberSet` and returns a `Promise` for each effect result.

Source: `effect@4.0.2/src/FiberSet.ts:255`.

Vivid `FiberSet.makeRuntimePromise` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeRuntimePromise: <R = never, A = unknown, E = unknown>() => Effect.Effect<(<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly propagateInterruption?: boolean | undefined;
}) | undefined) => Promise<XA>), never, R | Scope.Scope>;
```

## addUnsafe

Adds an existing fiber to the `FiberSet` using a synchronous, unsafe mutation.

Source: `effect@4.0.2/src/FiberSet.ts:313`.

Vivid `FiberSet.addUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const addUnsafe: {
    <A, E, XE extends E, XA extends A>(fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): (self: FiberSet<A, E>) => void;
    <A, E, XE extends E, XA extends A>(self: FiberSet<A, E>, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): void;
};
```

## add

Adds a fiber to the FiberSet. When the fiber completes, it will be removed.

Source: `effect@4.0.2/src/FiberSet.ts:464`.

Vivid `FiberSet.add` matches: 0. No qualified match. Bare-name matches: 248. Aliased usage is unverified.

```ts
export declare const add: {
    <A, E, XE extends E, XA extends A>(fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): (self: FiberSet<A, E>) => Effect.Effect<void>;
    <A, E, XE extends E, XA extends A>(self: FiberSet<A, E>, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly propagateInterruption?: boolean | undefined;
    } | undefined): Effect.Effect<void>;
};
```

## clear

Interrupts all fibers in the `FiberSet` and clears the set.

Source: `effect@4.0.2/src/FiberSet.ts:574`.

Vivid `FiberSet.clear` matches: 0. No qualified match. Bare-name matches: 107. Aliased usage is unverified.

```ts
export declare const clear: <A, E>(self: FiberSet<A, E>) => Effect.Effect<void>;
```

## run

Forks an Effect and adds the fiber to the FiberSet. The fiber is removed when it completes. Set `startImmediately: false` to defer startup. By default, the effect starts immediately.

Source: `effect@4.0.2/src/FiberSet.ts:621`.

Vivid `FiberSet.run` matches: 0. No qualified match. Bare-name matches: 1579. Aliased usage is unverified.

```ts
export declare const run: {
    <A, E>(self: FiberSet<A, E>, options?: {
        readonly propagateInterruption?: boolean | undefined;
        readonly startImmediately?: boolean | undefined;
    } | undefined): <R, XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>) => Effect.Effect<Fiber.Fiber<XA, XE>, never, R>;
    <A, E, R, XE extends E, XA extends A>(self: FiberSet<A, E>, effect: Effect.Effect<XA, XE, R>, options?: {
        readonly propagateInterruption?: boolean | undefined;
        readonly startImmediately?: boolean | undefined;
    } | undefined): Effect.Effect<Fiber.Fiber<XA, XE>, never, R>;
};
```

## runtime

Captures a `Runtime` and uses it to fork effects into the `FiberSet`.

Source: `effect@4.0.2/src/FiberSet.ts:761`.

Vivid `FiberSet.runtime` matches: 0. No qualified match. Bare-name matches: 785. Aliased usage is unverified.

```ts
export declare const runtime: <A, E>(self: FiberSet<A, E>) => <R = never>() => Effect.Effect<<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly propagateInterruption?: boolean | undefined;
}) | undefined) => Fiber.Fiber<XA, XE>, never, R>;
```

## runtimePromise

Captures a `Runtime` and returns a Promise-based runner that forks effects into the `FiberSet`.

Source: `effect@4.0.2/src/FiberSet.ts:832`.

Vivid `FiberSet.runtimePromise` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runtimePromise: <A, E>(self: FiberSet<A, E>) => <R = never>() => Effect.Effect<<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: (Effect.RunOptions & {
    readonly propagateInterruption?: boolean | undefined;
}) | undefined) => Promise<XA>, never, R>;
```

## size

Gets the number of fibers currently in the FiberSet.

Source: `effect@4.0.2/src/FiberSet.ts:891`.

Vivid `FiberSet.size` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const size: <A, E>(self: FiberSet<A, E>) => Effect.Effect<number>;
```

## join

Joins all fibers in the FiberSet. If any fiber in the set terminates with a failure, the returned Effect will terminate with the first failure that occurred.

Source: `effect@4.0.2/src/FiberSet.ts:919`.

Vivid `FiberSet.join` matches: 0. No qualified match. Bare-name matches: 601. Aliased usage is unverified.

```ts
export declare const join: <A, E>(self: FiberSet<A, E>) => Effect.Effect<void, E>;
```

## awaitEmpty

Waits until the fiber set is empty.

Source: `effect@4.0.2/src/FiberSet.ts:950`.

Vivid `FiberSet.awaitEmpty` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitEmpty: <A, E>(self: FiberSet<A, E>) => Effect.Effect<void>;
```
