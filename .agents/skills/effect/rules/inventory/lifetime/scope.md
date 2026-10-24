# Scope

Import `effect/Scope`. Source `effect@4.0.2/src/Scope.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 13. Module-name matches in Vivid: 184. apps/desktop/src/main/device.ts:24, apps/desktop/src/main/device.ts:187, apps/desktop/src/main/device.ts:296

## Scope

Service tag for the active resource lifetime.

Source: `effect@4.0.2/src/Scope.ts:219`.

Vivid `Scope.Scope` matches: 24. apps/desktop/src/main/device.ts:187, apps/desktop/src/main/device.ts:296, apps/desktop/src/main/turn.ts:127 Bare-name matches: 184. Aliased usage is unverified.

```ts
export interface Scope {
    readonly [TypeId]: typeof TypeId;
    readonly strategy: "sequential" | "parallel";
    readonly parent: Scope | undefined;
    state: State.Open | State.Closed | State.Empty;
}
export declare const Scope: Context.Service<Scope, Scope>;
```

## Closeable

A `Closeable` scope extends the base `Scope` interface with the ability to be closed, executing all registered finalizers.

Source: `effect@4.0.2/src/Scope.ts:77`.

Vivid `Scope.Closeable` matches: 2. apps/desktop/src/main/turn.ts:75, apps/server/src/computers/ssh/links.ts:48 Bare-name matches: 2. Aliased usage is unverified.

```ts
export interface Closeable extends Scope {
    readonly [CloseableTypeId]: typeof CloseableTypeId;
}
```

## State

Scope states: `Empty` has no finalizers, `Open` has at least one, and `Closed` holds the exit value.

Source: `effect@4.0.2/src/Scope.ts:103`.

Vivid `Scope.State` matches: 0. No qualified match. Bare-name matches: 50. Aliased usage is unverified.

```ts
export declare namespace State {
    type Empty = {
        readonly _tag: "Empty";
    };
    type Open = {
        readonly _tag: "Open";
        finalizerKey: {} | undefined;
        finalizer: ((exit: Exit<any, any>) => Effect<void>) | undefined;
        finalizers: Map<{}, (exit: Exit<any, any>) => Effect<void>> | undefined;
    };
    type Closed = {
        readonly _tag: "Closed";
        readonly exit: Exit<any, any>;
    };
}
```

## make

Creates a new `Scope` with the specified finalizer strategy.

Source: `effect@4.0.2/src/Scope.ts:245`.

Vivid `Scope.make` matches: 8. apps/desktop/src/main/main.ts:228, apps/desktop/src/main/main.ts:379, apps/server/src/computers/handlers.ts:73 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (finalizerStrategy?: "sequential" | "parallel") => Effect<Closeable>;
```

## makeUnsafe

Creates a new `Scope` synchronously without wrapping it in an `Effect`. This is useful when you need a scope immediately but should be used with caution as it doesn't provide the same safety guarantees as the `Effect`-wrapped version.

Source: `effect@4.0.2/src/Scope.ts:277`.

Vivid `Scope.makeUnsafe` matches: 0. No qualified match. Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: (finalizerStrategy?: "sequential" | "parallel") => Closeable;
```

## provide

Provides a concrete `Scope` to an effect.

Source: `effect@4.0.2/src/Scope.ts:317`.

Vivid `Scope.provide` matches: 9. apps/desktop/src/main/main.ts:252, apps/desktop/src/main/main.ts:389, apps/desktop/src/main/turn.ts:275 Bare-name matches: 483. Aliased usage is unverified.

```ts
export declare const provide: {
    (value: Scope): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Scope>>;
    <A, E, R>(self: Effect<A, E, R>, value: Scope): Effect<A, E, Exclude<R, Scope>>;
};
```

## addFinalizerExit

Registers an exit-aware finalizer on a scope.

Source: `effect@4.0.2/src/Scope.ts:432`.

Vivid `Scope.addFinalizerExit` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const addFinalizerExit: (scope: Scope, finalizer: (exit: Exit<any, any>) => Effect<unknown>) => Effect<void>;
```

## addFinalizer

Registers a finalizer effect on a scope.

Source: `effect@4.0.2/src/Scope.ts:467`.

Vivid `Scope.addFinalizer` matches: 2. apps/server/src/library/extraction/process.ts:450, packages/agent/runtime/src/notes.ts:289 Bare-name matches: 129. Aliased usage is unverified.

```ts
export declare const addFinalizer: (scope: Scope, finalizer: Effect<unknown>) => Effect<void>;
```

## fork

Creates a closeable child scope registered with a parent scope.

Source: `effect@4.0.2/src/Scope.ts:501`.

Vivid `Scope.fork` matches: 2. apps/desktop/src/main/turn.ts:266, packages/agent/runtime/src/notes.ts:272 Bare-name matches: 44. Aliased usage is unverified.

```ts
export declare const fork: (scope: Scope, finalizerStrategy?: "sequential" | "parallel") => Effect<Closeable>;
```

## forkUnsafe

Creates a closeable child scope synchronously and registers it with a parent scope.

Source: `effect@4.0.2/src/Scope.ts:543`.

Vivid `Scope.forkUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const forkUnsafe: (scope: Scope, finalizerStrategy?: "sequential" | "parallel") => Closeable;
```

## close

Closes a scope and runs its registered finalizers.

Source: `effect@4.0.2/src/Scope.ts:583`.

Vivid `Scope.close` matches: 18. apps/desktop/src/main/main.ts:230, apps/desktop/src/main/main.ts:381, apps/desktop/src/main/turn.ts:191 Bare-name matches: 453. Aliased usage is unverified.

```ts
export declare const close: <A, E>(self: Closeable, exit: Exit<A, E>) => Effect<void>;
```

## closeUnsafe

Closes a scope unsafely with the provided exit value.

Source: `effect@4.0.2/src/Scope.ts:611`.

Vivid `Scope.closeUnsafe` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const closeUnsafe: <A, E>(self: Closeable, exit_: Exit<A, E>) => Effect<void, never, never> | undefined;
```

## use

Runs an effect with the provided closeable scope in its context and closes that scope when the effect exits.

Source: `effect@4.0.2/src/Scope.ts:636`.

Vivid `Scope.use` matches: 0. No qualified match. Bare-name matches: 489. Aliased usage is unverified.

```ts
export declare const use: {
    (scope: Closeable): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Scope>>;
    <A, E, R>(self: Effect<A, E, R>, scope: Closeable): Effect<A, E, Exclude<R, Scope>>;
};
```
