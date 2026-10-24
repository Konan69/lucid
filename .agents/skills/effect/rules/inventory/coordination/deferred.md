# Deferred

Import `effect/Deferred`. Source `effect@4.0.2/src/Deferred.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 23. Module-name matches in Vivid: 776. apps/desktop/scripts/control.ts:7, apps/desktop/scripts/control.ts:164, apps/desktop/scripts/control.ts:166

## Deferred

Companion namespace containing type-level metadata for `Deferred`.

Source: `effect@4.0.2/src/Deferred.ts:89`.

Vivid `Deferred.Deferred` matches: 38. apps/desktop/src/main/computer.ts:150, apps/desktop/src/main/control.ts:553, apps/desktop/src/main/egress.test.ts:103 Bare-name matches: 776. Aliased usage is unverified.

```ts
export interface Deferred<in out A, in out E = never> extends Deferred.Variance<A, E>, Pipeable {
    effect?: Effect<A, E>;
    resumes?: Array<(effect: Effect<A, E>) => void> | undefined;
}
export declare namespace Deferred {
    interface Variance<in out A, in out E> {
        readonly [TypeId]: {
            readonly _A: Types.Invariant<A>;
            readonly _E: Types.Invariant<E>;
        };
    }
}
```

## isDeferred

Checks whether a value is a `Deferred`.

Source: `effect@4.0.2/src/Deferred.ts:77`.

Vivid `Deferred.isDeferred` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isDeferred: <A, E>(u: unknown) => u is Deferred<A, E>;
```

## makeUnsafe

Creates an empty `Deferred` synchronously outside the `Effect` runtime.

Source: `effect@4.0.2/src/Deferred.ts:151`.

Vivid `Deferred.makeUnsafe` matches: 18. apps/desktop/src/main/egress.test.ts:105, apps/desktop/src/main/egress.test.ts:315, apps/desktop/src/main/egress.ts:598 Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: <A, E = never>() => Deferred<A, E>;
```

## make

Creates a new `Deferred`.

Source: `effect@4.0.2/src/Deferred.ts:178`.

Vivid `Deferred.make` matches: 171. apps/desktop/scripts/control.ts:164, apps/desktop/scripts/control.ts:237, apps/desktop/scripts/control.ts:358 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A, E = never>() => Effect<Deferred<A, E>>;
```

## await

Retrieves the value of the `Deferred`, suspending the fiber running the workflow until the result is available.

Source: `effect@4.0.2/src/Deferred.ts:231`.

Vivid `Deferred.await` matches: 217. apps/desktop/scripts/control.ts:171, apps/desktop/scripts/control.ts:242, apps/desktop/scripts/control.ts:387 Bare-name matches: 395. Aliased usage is unverified.

```ts
declare const _await: <A, E>(self: Deferred<A, E>) => Effect<A, E>;
export { _await as await };
```

## complete

Runs the supplied `Effect` and attempts to complete the `Deferred` with its memoized result.

Source: `effect@4.0.2/src/Deferred.ts:269`.

Vivid `Deferred.complete` matches: 1. apps/server/src/connections/catalog.ts:30 Bare-name matches: 140. Aliased usage is unverified.

```ts
export declare const complete: {
    <A, E, R>(effect: Effect<A, E, R>): (self: Deferred<A, E>) => Effect<boolean, never, R>;
    <A, E, R>(self: Deferred<A, E>, effect: Effect<A, E, R>): Effect<boolean, never, R>;
};
```

## completeWith

Attempts to complete the `Deferred` with the specified effect directly.

Source: `effect@4.0.2/src/Deferred.ts:388`.

Vivid `Deferred.completeWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const completeWith: {
    <A, E>(effect: Effect<A, E>): (self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, effect: Effect<A, E>): Effect<boolean>;
};
```

## done

Completes the `Deferred` with the specified `Exit` value, which will be propagated to all fibers waiting on the value of the `Deferred`.

Source: `effect@4.0.2/src/Deferred.ts:513`.

Vivid `Deferred.done` matches: 0. No qualified match. Bare-name matches: 433. Aliased usage is unverified.

```ts
export declare const done: {
    <A, E>(exit: Exit.Exit<A, E>): (self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, exit: Exit.Exit<A, E>): Effect<boolean>;
};
```

## fail

Attempts to complete the `Deferred` with the specified error.

Source: `effect@4.0.2/src/Deferred.ts:622`.

Vivid `Deferred.fail` matches: 4. apps/server/src/code/process.ts:412, apps/server/src/library/extraction/process.ts:460, apps/server/src/threads/generation.test.ts:481 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: {
    <E>(error: E): <A>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, error: E): Effect<boolean>;
};
```

## failSync

Computes an error when the returned effect is run, then attempts to complete the `Deferred` with that error.

Source: `effect@4.0.2/src/Deferred.ts:725`.

Vivid `Deferred.failSync` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const failSync: {
    <E>(evaluate: LazyArg<E>): <A>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, evaluate: LazyArg<E>): Effect<boolean>;
};
```

## failCause

Attempts to complete the `Deferred` with the specified `Cause`.

Source: `effect@4.0.2/src/Deferred.ts:834`.

Vivid `Deferred.failCause` matches: 1. apps/server/src/threads/generation.test.ts:436 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const failCause: {
    <E>(cause: Cause.Cause<E>): <A>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, cause: Cause.Cause<E>): Effect<boolean>;
};
```

## failCauseSync

Computes a `Cause` when the returned effect is run, then attempts to complete the `Deferred` with that cause.

Source: `effect@4.0.2/src/Deferred.ts:940`.

Vivid `Deferred.failCauseSync` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const failCauseSync: {
    <E>(evaluate: LazyArg<Cause.Cause<E>>): <A>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, evaluate: LazyArg<Cause.Cause<E>>): Effect<boolean>;
};
```

## die

Attempts to complete the `Deferred` with a defect.

Source: `effect@4.0.2/src/Deferred.ts:1050`.

Vivid `Deferred.die` matches: 0. No qualified match. Bare-name matches: 95. Aliased usage is unverified.

```ts
export declare const die: {
    (defect: unknown): <A, E>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, defect: unknown): Effect<boolean>;
};
```

## dieSync

Computes a defect when the returned effect is run, then attempts to complete the `Deferred` with that defect.

Source: `effect@4.0.2/src/Deferred.ts:1155`.

Vivid `Deferred.dieSync` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dieSync: {
    (evaluate: LazyArg<unknown>): <A, E>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, evaluate: LazyArg<unknown>): Effect<boolean>;
};
```

## interrupt

Attempts to complete the `Deferred` with interruption by the current fiber.

Source: `effect@4.0.2/src/Deferred.ts:1267`.

Vivid `Deferred.interrupt` matches: 0. No qualified match. Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const interrupt: <A, E>(self: Deferred<A, E>) => Effect<boolean>;
```

## interruptWith

Attempts to complete the `Deferred` with interruption by the specified `FiberId`.

Source: `effect@4.0.2/src/Deferred.ts:1303`.

Vivid `Deferred.interruptWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interruptWith: {
    (fiberId: number): <A, E>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, fiberId: number): Effect<boolean>;
};
```

## isDone

Returns `true` if this `Deferred` has already been completed with a value or an error, `false` otherwise.

Source: `effect@4.0.2/src/Deferred.ts:1406`.

Vivid `Deferred.isDone` matches: 22. apps/server/src/code/calls.test.ts:958, apps/server/src/code/computer.ts:195, apps/server/src/code/computer.ts:201 Bare-name matches: 22. Aliased usage is unverified.

```ts
export declare const isDone: <A, E>(self: Deferred<A, E>) => Effect<boolean>;
```

## isDoneUnsafe

Returns whether this `Deferred` has already been completed synchronously.

Source: `effect@4.0.2/src/Deferred.ts:1423`.

Vivid `Deferred.isDoneUnsafe` matches: 4. apps/desktop/src/main/signin.ts:477, apps/server/src/computers/egress/relay.test.ts:243, apps/server/src/computers/egress/relay.test.ts:663 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const isDoneUnsafe: <A, E>(self: Deferred<A, E>) => boolean;
```

## poll

Returns the current completion effect as an `Option`. This returns `Option.some(effect)` when the `Deferred` is completed, `Option.none()` otherwise.

Source: `effect@4.0.2/src/Deferred.ts:1456`.

Vivid `Deferred.poll` matches: 2. apps/server/src/library/extraction.ts:84, apps/server/src/library/extraction.ts:90 Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare function poll<A, E>(self: Deferred<A, E>): Effect<Option.Option<Effect<A, E>>>;
```

## succeed

Attempts to complete the `Deferred` with the specified value.

Source: `effect@4.0.2/src/Deferred.ts:1492`.

Vivid `Deferred.succeed` matches: 163. apps/desktop/src/main/signin.ts:320, apps/desktop/src/main/signin.ts:343, apps/desktop/src/main/signin.ts:345 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const succeed: {
    <A>(value: A): <E>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, value: A): Effect<boolean>;
};
```

## sync

Computes a value when the returned effect is run, then attempts to complete the `Deferred` with that value.

Source: `effect@4.0.2/src/Deferred.ts:1594`.

Vivid `Deferred.sync` matches: 0. No qualified match. Bare-name matches: 487. Aliased usage is unverified.

```ts
export declare const sync: {
    <A>(evaluate: LazyArg<A>): <E>(self: Deferred<A, E>) => Effect<boolean>;
    <A, E>(self: Deferred<A, E>, evaluate: LazyArg<A>): Effect<boolean>;
};
```

## doneUnsafe

Attempts to complete the `Deferred` synchronously with the specified completion effect.

Source: `effect@4.0.2/src/Deferred.ts:1697`.

Vivid `Deferred.doneUnsafe` matches: 73. apps/desktop/scripts/control.ts:166, apps/desktop/scripts/control.ts:239, apps/desktop/scripts/control.ts:369 Bare-name matches: 73. Aliased usage is unverified.

```ts
export declare const doneUnsafe: <A, E>(self: Deferred<A, E>, effect: Effect<A, E>) => boolean;
```

## into

Runs an `Effect` and attempts to complete a `Deferred` with the effect's result.

Source: `effect@4.0.2/src/Deferred.ts:1750`.

Vivid `Deferred.into` matches: 0. No qualified match. Bare-name matches: 417. Aliased usage is unverified.

```ts
export declare const into: {
    <A, E>(deferred: Deferred<A, E>): <R>(self: Effect<A, E, R>) => Effect<boolean, never, R>;
    <A, E, R>(self: Effect<A, E, R>, deferred: Deferred<A, E>): Effect<boolean, never, R>;
};
```
