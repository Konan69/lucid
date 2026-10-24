# FiberHandle

Import `effect/FiberHandle`. Source `effect@4.0.2/src/FiberHandle.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 15. Module-name matches in Vivid: 0. No bare-name match.

## FiberHandle

Scoped handle that manages at most one fiber, interrupts the current fiber when the handle's scope closes, and removes managed fibers from the handle when they complete.

Source: `effect@4.0.2/src/FiberHandle.ts:59`.

Vivid `FiberHandle.FiberHandle` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FiberHandle<out A = unknown, out E = unknown> extends Pipeable, Inspectable.Inspectable {
    readonly [TypeId]: typeof TypeId;
    readonly deferred: Deferred.Deferred<void, unknown>;
    state: {
        readonly _tag: "Open";
        fiber: Fiber.Fiber<A, E> | undefined;
    } | {
        readonly _tag: "Closed";
    };
}
```

## isFiberHandle

Returns `true` if a value is a `FiberHandle` by checking for the `FiberHandle` runtime marker.

Source: `effect@4.0.2/src/FiberHandle.ts:93`.

Vivid `FiberHandle.isFiberHandle` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isFiberHandle: (u: unknown) => u is FiberHandle;
```

## make

Creates a scoped `FiberHandle` that can store a single fiber.

Source: `effect@4.0.2/src/FiberHandle.ts:150`.

Vivid `FiberHandle.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A = unknown, E = unknown>() => Effect.Effect<FiberHandle<A, E>, never, Scope.Scope>;
```

## makeRuntime

Creates a scoped run function that forks effects into a new `FiberHandle`.

Source: `effect@4.0.2/src/FiberHandle.ts:201`.

Vivid `FiberHandle.makeRuntime` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const makeRuntime: <R, E = unknown, A = unknown>() => Effect.Effect<<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: {
    readonly signal?: AbortSignal | undefined;
    readonly scheduler?: Scheduler | undefined;
    readonly onlyIfMissing?: boolean | undefined;
    readonly propagateInterruption?: boolean | undefined;
} | undefined) => Fiber.Fiber<XA, XE>, never, Scope.Scope | R>;
```

## makeRuntimePromise

Creates a scoped run function that forks effects into a new `FiberHandle` and returns a `Promise` for each effect result.

Source: `effect@4.0.2/src/FiberHandle.ts:257`.

Vivid `FiberHandle.makeRuntimePromise` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeRuntimePromise: <R = never, A = unknown, E = unknown>() => Effect.Effect<<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: {
    readonly signal?: AbortSignal | undefined;
    readonly scheduler?: Scheduler | undefined;
    readonly onlyIfMissing?: boolean | undefined;
    readonly propagateInterruption?: boolean | undefined;
} | undefined) => Promise<XA>, never, Scope.Scope | R>;
```

## setUnsafe

Sets the fiber in a FiberHandle. When the fiber completes, it will be removed from the FiberHandle. If a fiber is already running, it will be interrupted unless `options.onlyIfMissing` is set.

Source: `effect@4.0.2/src/FiberHandle.ts:314`.

Vivid `FiberHandle.setUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setUnsafe: {
    <A, E, XE extends E, XA extends A>(fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
    }): (self: FiberHandle<A, E>) => void;
    <A, E, XE extends E, XA extends A>(self: FiberHandle<A, E>, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean | undefined;
        readonly propagateInterruption?: boolean | undefined;
    }): void;
};
```

## set

Sets the fiber in the `FiberHandle`.

Source: `effect@4.0.2/src/FiberHandle.ts:472`.

Vivid `FiberHandle.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <A, E, XE extends E, XA extends A>(fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean;
        readonly propagateInterruption?: boolean | undefined;
    }): (self: FiberHandle<A, E>) => Effect.Effect<void>;
    <A, E, XE extends E, XA extends A>(self: FiberHandle<A, E>, fiber: Fiber.Fiber<XA, XE>, options?: {
        readonly onlyIfMissing?: boolean;
        readonly propagateInterruption?: boolean | undefined;
    }): Effect.Effect<void>;
};
```

## getUnsafe

Retrieves the fiber from the FiberHandle synchronously.

Source: `effect@4.0.2/src/FiberHandle.ts:602`.

Vivid `FiberHandle.getUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare function getUnsafe<A, E>(self: FiberHandle<A, E>): Option.Option<Fiber.Fiber<A, E>>;
```

## get

Retrieves the fiber from the FiberHandle effectfully.

Source: `effect@4.0.2/src/FiberHandle.ts:633`.

Vivid `FiberHandle.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare function get<A, E>(self: FiberHandle<A, E>): Effect.Effect<Option.Option<Fiber.Fiber<A, E>>>;
```

## clear

Interrupts the fiber currently stored in the `FiberHandle`, if any, and leaves the handle empty.

Source: `effect@4.0.2/src/FiberHandle.ts:667`.

Vivid `FiberHandle.clear` matches: 0. No qualified match. Bare-name matches: 107. Aliased usage is unverified.

```ts
export declare const clear: <A, E>(self: FiberHandle<A, E>) => Effect.Effect<void>;
```

## run

Forks an Effect and stores the resulting fiber in the `FiberHandle`.

Source: `effect@4.0.2/src/FiberHandle.ts:730`.

Vivid `FiberHandle.run` matches: 0. No qualified match. Bare-name matches: 1579. Aliased usage is unverified.

```ts
export declare const run: {
    <A, E>(self: FiberHandle<A, E>, options?: {
        readonly onlyIfMissing?: boolean;
        readonly propagateInterruption?: boolean | undefined;
        readonly startImmediately?: boolean | undefined;
    }): <R, XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>) => Effect.Effect<Fiber.Fiber<XA, XE>, never, R>;
    <A, E, R, XE extends E, XA extends A>(self: FiberHandle<A, E>, effect: Effect.Effect<XA, XE, R>, options?: {
        readonly onlyIfMissing?: boolean;
        readonly propagateInterruption?: boolean | undefined;
        readonly startImmediately?: boolean | undefined;
    }): Effect.Effect<Fiber.Fiber<XA, XE>, never, R>;
};
```

## runtime

Captures the current runtime and returns a function for forking effects into an existing `FiberHandle`.

Source: `effect@4.0.2/src/FiberHandle.ts:900`.

Vivid `FiberHandle.runtime` matches: 0. No qualified match. Bare-name matches: 785. Aliased usage is unverified.

```ts
export declare const runtime: <A, E>(self: FiberHandle<A, E>) => <R = never>() => Effect.Effect<<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: {
    readonly signal?: AbortSignal | undefined;
    readonly scheduler?: Scheduler | undefined;
    readonly onlyIfMissing?: boolean | undefined;
    readonly propagateInterruption?: boolean | undefined;
} | undefined) => Fiber.Fiber<XA, XE>, never, R>;
```

## runtimePromise

Captures the current runtime and returns a function for running effects in an existing `FiberHandle` as Promises.

Source: `effect@4.0.2/src/FiberHandle.ts:976`.

Vivid `FiberHandle.runtimePromise` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runtimePromise: <A, E>(self: FiberHandle<A, E>) => <R = never>() => Effect.Effect<<XE extends E, XA extends A>(effect: Effect.Effect<XA, XE, R>, options?: {
    readonly signal?: AbortSignal | undefined;
    readonly scheduler?: Scheduler | undefined;
    readonly onlyIfMissing?: boolean | undefined;
    readonly propagateInterruption?: boolean | undefined;
} | undefined) => Promise<XA>, never, R>;
```

## join

Waits for the `FiberHandle` to fail or close.

Source: `effect@4.0.2/src/FiberHandle.ts:1048`.

Vivid `FiberHandle.join` matches: 0. No qualified match. Bare-name matches: 601. Aliased usage is unverified.

```ts
export declare const join: <A, E>(self: FiberHandle<A, E>) => Effect.Effect<void, E>;
```

## awaitEmpty

Waits for the fiber in the FiberHandle to complete.

Source: `effect@4.0.2/src/FiberHandle.ts:1078`.

Vivid `FiberHandle.awaitEmpty` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitEmpty: <A, E>(self: FiberHandle<A, E>) => Effect.Effect<void, E>;
```
