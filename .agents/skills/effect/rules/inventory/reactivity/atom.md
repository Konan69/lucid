# Atom

Import `effect/reactivity/Atom`. Source `effect@4.0.2/src/reactivity/Atom.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 72. Module-name matches in Vivid: 160. apps/mobile/src/App.tsx:111, apps/mobile/src/data/appearance.ts:5, apps/mobile/src/data/appearance.ts:83

## TypeId

Runtime identifier attached to `Atom` values and used by `isAtom`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:62`.

Vivid `Atom.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type TypeId = "~effect/reactivity/Atom";
export declare const TypeId: TypeId;
```

## Atom

Reactive value read by an `AtomRegistry`, with metadata controlling caching, laziness, refresh behavior, and initial value targeting.

Source: `effect@4.0.2/src/reactivity/Atom.ts:71`.

Vivid `Atom.Atom` matches: 16. apps/mobile/src/data/connecting.ts:115, apps/mobile/src/data/door.ts:29, apps/mobile/src/data/held.ts:54 Bare-name matches: 160. Aliased usage is unverified.

```ts
export interface Atom<A> extends Pipeable, Inspectable.Inspectable {
    readonly [TypeId]: TypeId;
    readonly keepAlive: boolean;
    readonly lazy: boolean;
    readonly read: (get: AtomContext) => A;
    equals(value: A, next: A): boolean;
    readonly refresh?: (f: <A>(atom: Atom<A>) => void) => void;
    readonly label?: readonly [
        name: string,
        stack: string
    ];
    readonly idleTTL?: number;
    readonly initialValueTarget?: Atom<A>;
}
```

## isAtom

Returns `true` when a value is an `Atom`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:90`.

Vivid `Atom.isAtom` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isAtom: (u: unknown) => u is Atom<any>;
```

## Type

Extracts the value type produced by an `Atom`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:99`.

Vivid `Atom.Type` matches: 0. No qualified match. Bare-name matches: 937. Aliased usage is unverified.

```ts
export type Type<T extends Atom<any>> = T extends Atom<infer A> ? A : never;
```

## Success

Extracts the success value type from an atom whose value is an `AsyncResult`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:108`.

Vivid `Atom.Success` matches: 0. No qualified match. Bare-name matches: 102. Aliased usage is unverified.

```ts
export type Success<T extends Atom<any>> = T extends Atom<AsyncResult.AsyncResult<infer A, infer _>> ? A : never;
```

## PullSuccess

Extracts the item type from an atom whose value is a `PullResult`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:117`.

Vivid `Atom.PullSuccess` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type PullSuccess<T extends Atom<any>> = T extends Atom<PullResult<infer A, infer _>> ? A : never;
```

## Failure

Extracts the failure error type from an atom whose value is an `AsyncResult`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:126`.

Vivid `Atom.Failure` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export type Failure<T extends Atom<any>> = T extends Atom<AsyncResult.AsyncResult<infer _, infer E>> ? E : never;
```

## WithoutSerializable

Returns an atom type without serializable metadata, preserving `Writable` read and write types when the input atom is writable.

Source: `effect@4.0.2/src/reactivity/Atom.ts:135`.

Vivid `Atom.WithoutSerializable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type WithoutSerializable<T extends Atom<any>> = T extends Writable<infer R, infer W> ? Writable<R, W> : Atom<Type<T>>;
```

## WritableTypeId

Type-level identifier used to recognize writable atoms.

Source: `effect@4.0.2/src/reactivity/Atom.ts:154`.

Vivid `Atom.WritableTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const WritableTypeId: WritableTypeId;
export type WritableTypeId = "~effect/reactivity/Atom/Writable";
```

## Writable

Atom that can also be written to, using a `WriteContext` and an input value to update reactive state.

Source: `effect@4.0.2/src/reactivity/Atom.ts:163`.

Vivid `Atom.Writable` matches: 1. packages/client/state/src/live.ts:144 Bare-name matches: 6. Aliased usage is unverified.

```ts
export interface Writable<R, W = R> extends Atom<R> {
    readonly [WritableTypeId]: WritableTypeId;
    readonly write: (ctx: WriteContext<R>, value: W) => void;
}
```

## AtomContext

Context passed to atom read functions for reading dependencies, awaiting `AsyncResult` or `Option` values, managing subscriptions and finalizers, refreshing atoms, and updating writable atoms.

Source: `effect@4.0.2/src/reactivity/Atom.ts:175`.

Vivid `Atom.AtomContext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AtomContext {
    <A>(atom: Atom<A>): A;
    get<A>(this: AtomContext, atom: Atom<A>): A;
    result<A, E>(this: AtomContext, atom: Atom<AsyncResult.AsyncResult<A, E>>, options?: {
        readonly suspendOnWaiting?: boolean | undefined;
    }): Effect.Effect<A, E>;
    resultOnce<A, E>(this: AtomContext, atom: Atom<AsyncResult.AsyncResult<A, E>>, options?: {
        readonly suspendOnWaiting?: boolean | undefined;
    }): Effect.Effect<A, E>;
    once<A>(this: AtomContext, atom: Atom<A>): A;
    addFinalizer(this: AtomContext, f: () => void): void;
    mount<A>(this: AtomContext, atom: Atom<A>): void;
    refresh<A>(this: AtomContext, atom: Atom<A>): void;
    refreshSelf(this: AtomContext): void;
    self<A>(this: AtomContext): Option.Option<A>;
    setSelf<A>(this: AtomContext, a: A): void;
    set<R, W>(this: AtomContext, atom: Writable<R, W>, value: W): void;
    setResult<A, E, W>(this: AtomContext, atom: Writable<AsyncResult.AsyncResult<A, E>, W>, value: W): Effect.Effect<A, E>;
    some<A>(this: AtomContext, atom: Atom<Option.Option<A>>): Effect.Effect<A>;
    someOnce<A>(this: AtomContext, atom: Atom<Option.Option<A>>): Effect.Effect<A>;
    stream<A>(this: AtomContext, atom: Atom<A>, options?: {
        readonly withoutInitialValue?: boolean;
        readonly bufferSize?: number;
    }): Stream.Stream<A>;
    streamResult<A, E>(this: AtomContext, atom: Atom<AsyncResult.AsyncResult<A, E>>, options?: {
        readonly withoutInitialValue?: boolean;
        readonly bufferSize?: number;
    }): Stream.Stream<A, E>;
    subscribe<A>(this: AtomContext, atom: Atom<A>, f: (_: A) => void, options?: {
        readonly immediate?: boolean;
    }): void;
    readonly registry: Registry.AtomRegistry;
}
```

## WriteContext

Context passed to writable atom write functions for reading atoms, refreshing or setting the current atom, and writing to other writable atoms.

Source: `effect@4.0.2/src/reactivity/Atom.ts:216`.

Vivid `Atom.WriteContext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface WriteContext<A> {
    get<T>(this: WriteContext<A>, atom: Atom<T>): T;
    refreshSelf(this: WriteContext<A>): void;
    setSelf(this: WriteContext<A>, a: A): void;
    set<R, W>(this: WriteContext<A>, atom: Writable<R, W>, value: W): void;
}
```

## setIdleTTL

Returns a copy of an atom with an idle time-to-live: finite durations dispose it after inactivity, while an infinite duration keeps it alive.

Source: `effect@4.0.2/src/reactivity/Atom.ts:230`.

Vivid `Atom.setIdleTTL` matches: 2. packages/client/state/src/live.ts:461, packages/client/state/src/seen.ts:139 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const setIdleTTL: {
    (duration: Duration.Input): <A extends Atom<any>>(self: A) => A;
    <A extends Atom<any>>(self: A, duration: Duration.Input): A;
};
```

## isWritable

Returns `true` when an atom is writable.

Source: `effect@4.0.2/src/reactivity/Atom.ts:407`.

Vivid `Atom.isWritable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isWritable: <R, W>(atom: Atom<R>) => atom is Writable<R, W>;
```

## readable

Creates a read-only atom from a read function and an optional custom refresh registration callback.

Source: `effect@4.0.2/src/reactivity/Atom.ts:416`.

Vivid `Atom.readable` matches: 1. packages/client/state/src/seen.ts:140 Bare-name matches: 110. Aliased usage is unverified.

```ts
export declare const readable: <A>(read: (get: AtomContext) => A, refresh?: (f: <A_1>(atom: Atom<A_1>) => void) => void) => Atom<A>;
```

## writable

Creates a writable atom from read and write functions, with an optional custom refresh registration callback.

Source: `effect@4.0.2/src/reactivity/Atom.ts:435`.

Vivid `Atom.writable` matches: 0. No qualified match. Bare-name matches: 10. Aliased usage is unverified.

```ts
export declare const writable: <R, W>(read: (get: AtomContext) => R, write: (ctx: WriteContext<R>, value: W) => void, refresh?: (f: <A>(atom: Atom<A>) => void) => void) => Writable<R, W>;
```

## make

Creates an atom from a synchronous value or read function, or from an `Effect` or `Stream` whose state is exposed as an `AsyncResult`; plain values create writable state atoms.

Source: `effect@4.0.2/src/reactivity/Atom.ts:464`.

Vivid `Atom.make` matches: 49. apps/mobile/src/data/appearance.ts:83, apps/mobile/src/data/appearance.ts:84, apps/mobile/src/data/appearance.ts:88 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: {
    <A, E>(create: (get: AtomContext) => Effect.Effect<A, E, Scope.Scope | AtomRegistry>, options?: {
        readonly initialValue?: A | undefined;
        readonly uninterruptible?: boolean | undefined;
    }): Atom<AsyncResult.AsyncResult<A, E>>;
    <A, E>(effect: Effect.Effect<A, E, Scope.Scope | AtomRegistry>, options?: {
        readonly initialValue?: A;
        readonly uninterruptible?: boolean | undefined;
    }): Atom<AsyncResult.AsyncResult<A, E>>;
    <A, E>(create: (get: AtomContext) => Stream.Stream<A, E, AtomRegistry>, options?: {
        readonly initialValue?: A;
    }): Atom<AsyncResult.AsyncResult<A, E | Cause.NoSuchElementError>>;
    <A, E>(stream: Stream.Stream<A, E, AtomRegistry>, options?: {
        readonly initialValue?: A;
    }): Atom<AsyncResult.AsyncResult<A, E | Cause.NoSuchElementError>>;
    <A>(create: (get: AtomContext) => A): Atom<A>;
    <A>(initialValue: A): Writable<A>;
};
```

## AtomRuntime

Atom that builds a `Context` from a `Layer` and exposes constructors for atoms, functions, pulls, and subscription refs that run with that context.

Source: `effect@4.0.2/src/reactivity/Atom.ts:743`.

Vivid `Atom.AtomRuntime` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AtomRuntime<R, ER = never> extends Atom<AsyncResult.AsyncResult<Context.Context<R>, ER>> {
    readonly factory: RuntimeFactory;
    readonly layer: Atom<Layer.Layer<R, ER>>;
    readonly atom: {
        <A, E>(create: (get: AtomContext) => Effect.Effect<A, E, Scope.Scope | R | AtomRegistry | Reactivity.Reactivity>, options?: {
            readonly initialValue?: A;
            readonly uninterruptible?: boolean | undefined;
        }): Atom<AsyncResult.AsyncResult<A, E | ER>>;
        <A, E>(effect: Effect.Effect<A, E, Scope.Scope | R | AtomRegistry | Reactivity.Reactivity>, options?: {
            readonly initialValue?: A;
            readonly uninterruptible?: boolean | undefined;
        }): Atom<AsyncResult.AsyncResult<A, E | ER>>;
        <A, E>(create: (get: AtomContext) => Stream.Stream<A, E, AtomRegistry | Reactivity.Reactivity | R>, options?: {
            readonly initialValue?: A;
        }): Atom<AsyncResult.AsyncResult<A, E | ER | Cause.NoSuchElementError>>;
        <A, E>(stream: Stream.Stream<A, E, AtomRegistry | Reactivity.Reactivity | R>, options?: {
            readonly initialValue?: A;
        }): Atom<AsyncResult.AsyncResult<A, E | ER | Cause.NoSuchElementError>>;
    };
    readonly fn: {
        <Arg>(): {
            <E, A>(fn: (arg: Arg, get: FnContext) => Effect.Effect<A, E, Scope.Scope | AtomRegistry | Reactivity.Reactivity | R>, options?: {
                readonly initialValue?: A | undefined;
                readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
                readonly concurrent?: boolean | undefined;
            }): AtomResultFn<Arg, A, E | ER>;
            <E, A>(fn: (arg: Arg, get: FnContext) => Stream.Stream<A, E, AtomRegistry | Reactivity.Reactivity | R>, options?: {
                readonly initialValue?: A | undefined;
                readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
                readonly concurrent?: boolean | undefined;
            }): AtomResultFn<Arg, A, E | ER | Cause.NoSuchElementError>;
        };
        <E, A, Arg = void>(fn: (arg: Arg, get: FnContext) => Effect.Effect<A, E, Scope.Scope | AtomRegistry | Reactivity.Reactivity | R>, options?: {
            readonly initialValue?: A | undefined;
            readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
            readonly concurrent?: boolean | undefined;
        }): AtomResultFn<Arg, A, E | ER>;
        <E, A, Arg = void>(fn: (arg: Arg, get: FnContext) => Stream.Stream<A, E, AtomRegistry | Reactivity.Reactivity | R>, options?: {
            readonly initialValue?: A | undefined;
            readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
            readonly concurrent?: boolean | undefined;
        }): AtomResultFn<Arg, A, E | ER | Cause.NoSuchElementError>;
    };
    readonly pull: <A, E>(create: ((get: AtomContext) => Stream.Stream<A, E, R | AtomRegistry | Reactivity.Reactivity>) | Stream.Stream<A, E, R | AtomRegistry | Reactivity.Reactivity>, options?: {
        readonly disableAccumulation?: boolean;
        readonly initialValue?: ReadonlyArray<A>;
    }) => Writable<PullResult<A, E | ER>, void>;
    readonly subscriptionRef: <A, E>(create: Effect.Effect<SubscriptionRef.SubscriptionRef<A>, E, Scope.Scope | R | AtomRegistry | Reactivity.Reactivity> | ((get: AtomContext) => Effect.Effect<SubscriptionRef.SubscriptionRef<A>, E, Scope.Scope | R | AtomRegistry | Reactivity.Reactivity>)) => Writable<AsyncResult.AsyncResult<A, E | ER>, A>;
}
```

## RuntimeFactory

Factory for `AtomRuntime` values that share a set of global layers.

Source: `effect@4.0.2/src/reactivity/Atom.ts:831`.

Vivid `Atom.RuntimeFactory` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface RuntimeFactory {
    <R, E>(create: Layer.Layer<R, E, AtomRegistry | Reactivity.Reactivity> | ((get: AtomContext) => Layer.Layer<R, E, AtomRegistry | Reactivity.Reactivity>)): AtomRuntime<R, E>;
    readonly addGlobalLayer: <A, E>(layer: Layer.Layer<A, E, AtomRegistry | Reactivity.Reactivity>) => void;
    readonly withReactivity: (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>) => <A extends Atom<any>>(atom: A) => A;
}
```

## RegistryRuntimeFactory

A `RuntimeFactory` backed by an atom whose memo map is scoped to each registry.

Source: `effect@4.0.2/src/reactivity/Atom.ts:855`.

Vivid `Atom.RegistryRuntimeFactory` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface RegistryRuntimeFactory extends RuntimeFactory {
    readonly memoMap: Atom<Layer.MemoMap>;
}
```

## SharedRuntimeFactory

A `RuntimeFactory` backed by a concrete memo map shared across registries.

Source: `effect@4.0.2/src/reactivity/Atom.ts:866`.

Vivid `Atom.SharedRuntimeFactory` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SharedRuntimeFactory extends RuntimeFactory {
    readonly memoMap: Layer.MemoMap;
}
```

## context

Creates a `RuntimeFactory` backed by a registry-scoped memo map by default, or by the supplied atom or concrete `Layer.MemoMap`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:878`.

Vivid `Atom.context` matches: 0. No qualified match. Bare-name matches: 926. Aliased usage is unverified.

```ts
export declare function context(): RegistryRuntimeFactory;
export declare function context(options: {
    readonly memoMap: Atom<Layer.MemoMap>;
}): RegistryRuntimeFactory;
export declare function context(options: {
    readonly memoMap: Layer.MemoMap;
}): SharedRuntimeFactory;
```

## runtime

Default registry-scoped `RuntimeFactory`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:956`.

Vivid `Atom.runtime` matches: 4. packages/client/state/src/connecting.ts:816, packages/client/state/src/deciding.ts:78, packages/client/state/src/feed.ts:398 Bare-name matches: 785. Aliased usage is unverified.

```ts
export declare const runtime: RegistryRuntimeFactory;
```

## withReactivity

Returns `Rx.runtime.withReactivity` for refreshing an atom whenever the keys change in the `Reactivity` service.

Source: `effect@4.0.2/src/reactivity/Atom.ts:971`.

Vivid `Atom.withReactivity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withReactivity: (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>) => <A extends Atom<any>>(atom: A) => A;
```

## subscriptionRef

Creates a writable atom backed by a `SubscriptionRef`, or by an effect that produces one, updating from ref changes and writing atom updates back to the ref.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1068`.

Vivid `Atom.subscriptionRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const subscriptionRef: {
    <A>(ref: SubscriptionRef.SubscriptionRef<A> | ((get: AtomContext) => SubscriptionRef.SubscriptionRef<A>)): Writable<A>;
    <A, E>(effect: Effect.Effect<SubscriptionRef.SubscriptionRef<A>, E, Scope.Scope | AtomRegistry> | ((get: AtomContext) => Effect.Effect<SubscriptionRef.SubscriptionRef<A>, E, Scope.Scope | AtomRegistry>)): Writable<AsyncResult.AsyncResult<A, E>, A>;
};
```

## FnContext

Context passed to `fn` and `fnSync` computations for reading atoms, awaiting results, registering finalizers, refreshing atoms, subscribing to changes, and writing updates.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1181`.

Vivid `Atom.FnContext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FnContext {
    <A>(atom: Atom<A>): A;
    result<A, E>(this: FnContext, atom: Atom<AsyncResult.AsyncResult<A, E>>, options?: {
        readonly suspendOnWaiting?: boolean | undefined;
    }): Effect.Effect<A, E>;
    addFinalizer(this: FnContext, f: () => void): void;
    mount<A>(this: FnContext, atom: Atom<A>): void;
    refresh<A>(this: FnContext, atom: Atom<A>): void;
    self<A>(this: FnContext): Option.Option<A>;
    setSelf<A>(this: FnContext, a: A): void;
    set<R, W>(this: FnContext, atom: Writable<R, W>, value: W): void;
    setResult<A, E, W>(this: FnContext, atom: Writable<AsyncResult.AsyncResult<A, E>, W>, value: W): Effect.Effect<A, E>;
    some<A>(this: FnContext, atom: Atom<Option.Option<A>>): Effect.Effect<A>;
    stream<A>(this: FnContext, atom: Atom<A>, options?: {
        readonly withoutInitialValue?: boolean;
        readonly bufferSize?: number;
    }): Stream.Stream<A>;
    streamResult<A, E>(this: FnContext, atom: Atom<AsyncResult.AsyncResult<A, E>>, options?: {
        readonly withoutInitialValue?: boolean;
        readonly bufferSize?: number;
    }): Stream.Stream<A, E>;
    subscribe<A>(this: FnContext, atom: Atom<A>, f: (_: A) => void, options?: {
        readonly immediate?: boolean;
    }): void;
    readonly registry: Registry.AtomRegistry;
}
```

## fnSync

Creates a writable atom for a synchronous function; writing an argument re-runs the function, returning `Option.none` before the first call unless an initial value is supplied.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1215`.

Vivid `Atom.fnSync` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fnSync: {
    <Arg>(): {
        <A>(f: (arg: Arg, get: FnContext) => A): Writable<Option.Option<A>, Arg>;
        <A>(f: (arg: Arg, get: FnContext) => A, options: {
            readonly initialValue: A;
        }): Writable<A, Arg>;
    };
    <A, Arg = void>(f: (arg: Arg, get: FnContext) => A): Writable<Option.Option<A>, Arg>;
    <A, Arg = void>(f: (arg: Arg, get: FnContext) => A, options: {
        readonly initialValue: A;
    }): Writable<A, Arg>;
};
```

## AtomResultFn

Writable async function atom whose value is an `AsyncResult` and whose writes accept function arguments plus `Reset` and `Interrupt` controls.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1291`.

Vivid `Atom.AtomResultFn` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AtomResultFn<Arg, A, E = never> extends Writable<AsyncResult.AsyncResult<A, E>, Arg | Reset | Interrupt> {
}
```

## Reset

Type of the `Reset` control symbol accepted by `AtomResultFn` writes.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1316`.

Vivid `Atom.Reset` matches: 0. No qualified match. Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const Reset: unique symbol;
export type Reset = typeof Reset;
```

## Interrupt

Type of the `Interrupt` control symbol accepted by `AtomResultFn` writes.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1339`.

Vivid `Atom.Interrupt` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const Interrupt: unique symbol;
export type Interrupt = typeof Interrupt;
```

## fn

Creates a writable atom for an `Effect` or `Stream` function; writing an argument starts the computation and exposes its state as an `AsyncResult`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1348`.

Vivid `Atom.fn` matches: 9. apps/mobile/src/data/appearance.ts:99, apps/mobile/src/data/appearance.ts:132, apps/mobile/src/data/feed.ts:39 Bare-name matches: 1901. Aliased usage is unverified.

```ts
export declare const fn: {
    <Arg>(): <E, A>(fn: (arg: Arg, get: FnContext) => Effect.Effect<A, E, Scope.Scope | AtomRegistry>, options?: {
        readonly initialValue?: A | undefined;
        readonly concurrent?: boolean | undefined;
    }) => AtomResultFn<Arg, A, E>;
    <E, A, Arg = void>(fn: (arg: Arg, get: FnContext) => Effect.Effect<A, E, Scope.Scope | AtomRegistry>, options?: {
        readonly initialValue?: A | undefined;
        readonly concurrent?: boolean | undefined;
    }): AtomResultFn<Arg, A, E>;
    <Arg>(): <E, A>(fn: (arg: Arg, get: FnContext) => Stream.Stream<A, E, AtomRegistry>, options?: {
        readonly initialValue?: A | undefined;
        readonly concurrent?: boolean | undefined;
    }) => AtomResultFn<Arg, A, E | Cause.NoSuchElementError>;
    <E, A, Arg = void>(fn: (arg: Arg, get: FnContext) => Stream.Stream<A, E, AtomRegistry>, options?: {
        readonly initialValue?: A | undefined;
        readonly concurrent?: boolean | undefined;
    }): AtomResultFn<Arg, A, E | Cause.NoSuchElementError>;
};
```

## PullResult

`AsyncResult` produced by `pull`, containing a non-empty batch of pulled items and a `done` flag, or `NoSuchElementError` when the stream completes without items.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1491`.

Vivid `Atom.PullResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type PullResult<A, E = never> = AsyncResult.AsyncResult<{
    readonly done: boolean;
    readonly items: Arr.NonEmptyArray<A>;
}, E | Cause.NoSuchElementError>;
```

## pull

Creates a writable atom that pulls an initial chunk from a stream and then pulls the next chunk whenever it is written to, accumulating items unless `disableAccumulation` is enabled.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1503`.

Vivid `Atom.pull` matches: 0. No qualified match. Bare-name matches: 25. Aliased usage is unverified.

```ts
export declare const pull: <A, E>(create: ((get: AtomContext) => Stream.Stream<A, E, AtomRegistry>) | Stream.Stream<A, E, AtomRegistry>, options?: {
    readonly disableAccumulation?: boolean | undefined;
}) => Writable<PullResult<A, E>, void>;
```

## family

Creates a memoized atom factory that returns the same object for the same argument, using weak references for cached values when the platform supports them.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1603`.

Vivid `Atom.family` matches: 6. apps/mobile/src/data/drafts.ts:70, apps/mobile/src/data/live.ts:332, apps/mobile/src/data/live.ts:346 Bare-name matches: 126. Aliased usage is unverified.

```ts
export declare const family: <Arg, T extends object>(f: (arg: Arg) => T) => (arg: Arg) => T;
```

## withFallback

Uses a fallback `AsyncResult` atom while the primary atom is `Initial`, marking the fallback result as waiting until the primary atom produces a non-initial result.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1650`.

Vivid `Atom.withFallback` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withFallback: {
    <E2, A2>(fallback: Atom<AsyncResult.AsyncResult<A2, E2>>): <R extends Atom<AsyncResult.AsyncResult<any, any>>>(self: R) => [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<AsyncResult.AsyncResult<AsyncResult.AsyncResult.Success<Type<R>> | A2, AsyncResult.AsyncResult.Failure<Type<R>> | E2>, RW> : Atom<AsyncResult.AsyncResult<AsyncResult.AsyncResult.Success<Type<R>> | A2, AsyncResult.AsyncResult.Failure<Type<R>> | E2>>;
    <R extends Atom<AsyncResult.AsyncResult<any, any>>, A2, E2>(self: R, fallback: Atom<AsyncResult.AsyncResult<A2, E2>>): [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<AsyncResult.AsyncResult<AsyncResult.AsyncResult.Success<Type<R>> | A2, AsyncResult.AsyncResult.Failure<Type<R>> | E2>, RW> : Atom<AsyncResult.AsyncResult<AsyncResult.AsyncResult.Success<Type<R>> | A2, AsyncResult.AsyncResult.Failure<Type<R>> | E2>>;
};
```

## keepAlive

Returns a copy of an atom that remains cached and mounted even when no subscribers are using it.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1742`.

Vivid `Atom.keepAlive` matches: 33. apps/mobile/src/data/appearance.ts:83, apps/mobile/src/data/appearance.ts:84, apps/mobile/src/data/appearance.ts:87 Bare-name matches: 41. Aliased usage is unverified.

```ts
export declare const keepAlive: <A extends Atom<any>>(self: A) => A;
```

## autoDispose

Allows a reactive value to be disposed of when it is not in use.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1759`.

Vivid `Atom.autoDispose` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const autoDispose: <A extends Atom<any>>(self: A) => A;
```

## setLazy

Sets whether an atom should be lazy.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1777`.

Vivid `Atom.setLazy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setLazy: {
    (lazy: boolean): <A extends Atom<any>>(self: A) => A;
    <A extends Atom<any>>(self: A, lazy: boolean): A;
};
```

## withEquality

Returns a copy of an atom that uses a custom equality function to detect value changes.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1838`.

Vivid `Atom.withEquality` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withEquality: {
    <A>(equals: (value: A, next: A) => boolean): <T extends Atom<A>>(self: T) => T;
    <T extends Atom<any>>(self: T, equals: (value: Type<T>, next: Type<T>) => boolean): T;
};
```

## withLabel

Attaches a diagnostic label to an atom.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1918`.

Vivid `Atom.withLabel` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withLabel: {
    (name: string): <A extends Atom<any>>(self: A) => A;
    <A extends Atom<any>>(self: A, name: string): A;
};
```

## initialValue

Pairs an atom with an initial value for registry initialization.

Source: `effect@4.0.2/src/reactivity/Atom.ts:1994`.

Vivid `Atom.initialValue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const initialValue: {
    <A>(initialValue: A): (self: Atom<A>) => readonly [
        Atom<A>,
        A
    ];
    <A>(self: Atom<A>, initialValue: A): readonly [
        Atom<A>,
        A
    ];
};
```

## transform

Creates a derived atom by reading another atom with a custom `AtomContext` function.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2080`.

Vivid `Atom.transform` matches: 0. No qualified match. Bare-name matches: 89. Aliased usage is unverified.

```ts
export declare const transform: {
    <R extends Atom<any>, B>(f: (get: AtomContext, atom: R) => B, options?: {
        readonly initialValueTarget?: Atom<B> | undefined;
    }): (self: R) => [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<B, RW> : Atom<B>;
    <R extends Atom<any>, B>(self: R, f: (get: AtomContext, atom: R) => B, options?: {
        readonly initialValueTarget?: Atom<B> | undefined;
    }): [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<B, RW> : Atom<B>;
};
```

## map

Maps the current value of an atom with a pure function.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2178`.

Vivid `Atom.map` matches: 3. apps/mobile/src/data/connecting.ts:283, apps/web/src/data/connecting.ts:158, packages/client/state/src/deciding.ts:79 Bare-name matches: 1501. Aliased usage is unverified.

```ts
export declare const map: {
    <R extends Atom<any>, B>(f: (_: Type<R>) => B): (self: R) => [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<B, RW> : Atom<B>;
    <R extends Atom<any>, B>(self: R, f: (_: Type<R>) => B): [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<B, RW> : Atom<B>;
};
```

## mapResult

Maps the successful value inside an `AsyncResult` atom.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2222`.

Vivid `Atom.mapResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapResult: {
    <R extends Atom<AsyncResult.AsyncResult<any, any>>, B>(f: (_: AsyncResult.AsyncResult.Success<Type<R>>) => B): (self: R) => [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<AsyncResult.AsyncResult<B, AsyncResult.AsyncResult.Failure<Type<R>>>, RW> : Atom<AsyncResult.AsyncResult<B, AsyncResult.AsyncResult.Failure<Type<R>>>>;
    <R extends Atom<AsyncResult.AsyncResult<any, any>>, B>(self: R, f: (_: AsyncResult.AsyncResult.Success<Type<R>>) => B): [
        R
    ] extends [
        Writable<infer _, infer RW>
    ] ? Writable<AsyncResult.AsyncResult<B, AsyncResult.AsyncResult.Failure<Type<R>>>, RW> : Atom<AsyncResult.AsyncResult<B, AsyncResult.AsyncResult.Failure<Type<R>>>>;
};
```

## debounce

Creates an atom that publishes source changes only after the source has stopped changing for the specified duration.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2275`.

Vivid `Atom.debounce` matches: 1. packages/client/state/src/live.ts:430 Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const debounce: {
    (duration: Duration.Input): <A extends Atom<any>>(self: A) => WithoutSerializable<A>;
    <A extends Atom<any>>(self: A, duration: Duration.Input): WithoutSerializable<A>;
};
```

## withRefresh

Creates a derived atom that reads the source and schedules a refresh after the specified duration.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2340`.

Vivid `Atom.withRefresh` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withRefresh: {
    (duration: Duration.Input): <A extends Atom<any>>(self: A) => WithoutSerializable<A>;
    <A extends Atom<any>>(self: A, duration: Duration.Input): WithoutSerializable<A>;
};
```

## swr

Adds stale-while-revalidate refresh behavior to an async result atom.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2394`.

Vivid `Atom.swr` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const swr: {
    (options: {
        readonly staleTime: Duration.Input;
        readonly revalidateOnMount?: boolean | undefined;
        readonly revalidateOnFocus?: boolean | "always" | undefined;
        readonly focusSignal?: Atom<any> | undefined;
    }): <R extends Atom<AsyncResult.AsyncResult<any, any>>>(self: R) => WithoutSerializable<R>;
    <R extends Atom<AsyncResult.AsyncResult<any, any>>>(self: R, options: {
        readonly staleTime: Duration.Input;
        readonly revalidateOnMount?: boolean | undefined;
        readonly revalidateOnFocus?: boolean | "always" | undefined;
        readonly focusSignal?: Atom<any> | undefined;
    }): WithoutSerializable<R>;
};
```

## optimistic

Wraps an atom in a writable optimistic atom.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2528`.

Vivid `Atom.optimistic` matches: 1. packages/client/state/src/live.ts:106 Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const optimistic: <A>(self: Atom<A>) => Writable<A, Atom<AsyncResult.AsyncResult<A, unknown>>>;
```

## optimisticFn

Creates an `AtomResultFn` that applies an optimistic update before running the underlying mutation.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2632`.

Vivid `Atom.optimisticFn` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const optimisticFn: {
    <A, W, XA, XE, OW = void>(options: {
        readonly reducer: (current: NoInfer<A>, update: OW) => NoInfer<W>;
        readonly fn: AtomResultFn<OW, XA, XE> | ((set: (result: NoInfer<W>) => void) => AtomResultFn<OW, XA, XE>);
    }): (self: Writable<A, Atom<AsyncResult.AsyncResult<W, unknown>>>) => AtomResultFn<OW, XA, XE>;
    <A, W, XA, XE, OW = void>(self: Writable<A, Atom<AsyncResult.AsyncResult<W, unknown>>>, options: {
        readonly reducer: (current: NoInfer<A>, update: OW) => NoInfer<W>;
        readonly fn: AtomResultFn<OW, XA, XE> | ((set: (result: NoInfer<W>) => void) => AtomResultFn<OW, XA, XE>);
    }): AtomResultFn<OW, XA, XE>;
};
```

## batch

Runs synchronous atom updates as a batch.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2770`.

Vivid `Atom.batch` matches: 0. No qualified match. Bare-name matches: 108. Aliased usage is unverified.

```ts
export declare const batch: (f: () => void) => void;
```

## windowFocusSignal

Creates a signal atom that increments when the document becomes visible.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2788`.

Vivid `Atom.windowFocusSignal` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const windowFocusSignal: Atom<number>;
```

## makeRefreshOnSignal

Creates a combinator that refreshes an atom whenever the supplied signal atom changes.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2818`.

Vivid `Atom.makeRefreshOnSignal` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeRefreshOnSignal: <_>(signal: Atom<_>) => <A extends Atom<any>>(self: A) => WithoutSerializable<A>;
```

## refreshOnWindowFocus

Refreshes an atom whenever `windowFocusSignal` changes.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2838`.

Vivid `Atom.refreshOnWindowFocus` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const refreshOnWindowFocus: <A extends Atom<any>>(self: A) => WithoutSerializable<A>;
```

## kvs

Creates a writable atom backed by a `KeyValueStore` entry.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2859`.

Vivid `Atom.kvs` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const kvs: <S extends Schema.ConstraintCodec<any, any>, const Mode extends "sync" | "async" = never>(options: {
    readonly runtime: AtomRuntime<KeyValueStore.KeyValueStore, any>;
    readonly key: string;
    readonly schema: S;
    readonly defaultValue: LazyArg<S["Type"]>;
    readonly mode?: Mode | undefined;
}) => Writable<"async" extends Mode ? AsyncResult.AsyncResult<S["Type"]> : S["Type"], S["Type"]>;
```

## searchParam

Creates an atom that reads and writes a URL search parameter.

Source: `effect@4.0.2/src/reactivity/Atom.ts:2925`.

Vivid `Atom.searchParam` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const searchParam: <S extends Schema.ConstraintCodec<any, string> = never>(name: string, options?: {
    readonly schema?: S | undefined;
}) => Writable<[
    S
] extends [
    never
] ? string : Option.Option<S["Type"]>>;
```

## toStream

Converts an atom into a stream using the `AtomRegistry` service.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3019`.

Vivid `Atom.toStream` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const toStream: <A>(self: Atom<A>) => Stream.Stream<A, never, AtomRegistry>;
```

## toStreamResult

Converts an `AsyncResult` atom into a stream using the `AtomRegistry` service.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3034`.

Vivid `Atom.toStreamResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toStreamResult: <A, E>(self: Atom<AsyncResult.AsyncResult<A, E>>) => Stream.Stream<A, E, AtomRegistry>;
```

## get

Reads an atom's current value from the `AtomRegistry` service.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3044`.

Vivid `Atom.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A>(self: Atom<A>) => Effect.Effect<A, never, AtomRegistry>;
```

## modify

Reads a writable atom, computes a return value and next write value, writes the next value, and returns the computed result.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3055`.

Vivid `Atom.modify` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const modify: {
    <R, W, A>(f: (_: R) => [
        returnValue: A,
        nextValue: W
    ]): (self: Writable<R, W>) => Effect.Effect<A, never, AtomRegistry>;
    <R, W, A>(self: Writable<R, W>, f: (_: R) => [
        returnValue: A,
        nextValue: W
    ]): Effect.Effect<A, never, AtomRegistry>;
};
```

## set

Writes a value to a writable atom through the `AtomRegistry` service.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3087`.

Vivid `Atom.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <W>(value: W): <R>(self: Writable<R, W>) => Effect.Effect<void, never, AtomRegistry>;
    <R, W>(self: Writable<R, W>, value: W): Effect.Effect<void, never, AtomRegistry>;
};
```

## update

Updates a writable atom by reading its current value from the registry and writing the value returned by the update function.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3118`.

Vivid `Atom.update` matches: 0. No qualified match. Bare-name matches: 531. Aliased usage is unverified.

```ts
export declare const update: {
    <R, W>(f: (_: R) => W): (self: Writable<R, W>) => Effect.Effect<void, never, AtomRegistry>;
    <R, W>(self: Writable<R, W>, f: (_: R) => W): Effect.Effect<void, never, AtomRegistry>;
};
```

## getResult

Reads an `AsyncResult` atom as an effect through the `AtomRegistry` service.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3156`.

Vivid `Atom.getResult` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const getResult: <A, E>(self: Atom<AsyncResult.AsyncResult<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined;
}) => Effect.Effect<A, E, AtomRegistry>;
```

## refresh

Runs a refresh request for an atom through the `AtomRegistry` service.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3173`.

Vivid `Atom.refresh` matches: 0. No qualified match. Bare-name matches: 51. Aliased usage is unverified.

```ts
export declare const refresh: <A>(self: Atom<A>) => Effect.Effect<void, never, AtomRegistry>;
```

## mount

Mounts an atom in the `AtomRegistry` for the lifetime of the current scope.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3188`.

Vivid `Atom.mount` matches: 0. No qualified match. Bare-name matches: 14. Aliased usage is unverified.

```ts
export declare const mount: <A>(self: Atom<A>) => Effect.Effect<void, never, AtomRegistry | Scope.Scope>;
```

## SerializableTypeId

The literal type of the serializable atom marker.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3211`.

Vivid `Atom.SerializableTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const SerializableTypeId: SerializableTypeId;
export type SerializableTypeId = "~effect-atom/atom/Atom/Serializable";
```

## Serializable

Serialization metadata attached to an atom.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3225`.

Vivid `Atom.Serializable` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export interface Serializable<S extends Schema.Constraint> {
    readonly [SerializableTypeId]: {
        readonly key: string;
        readonly encode: (value: S["Type"]) => S["Encoded"];
        readonly decode: (value: S["Encoded"]) => S["Type"];
    };
}
```

## isSerializable

Returns `true` when an atom carries `Serializable` metadata.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3240`.

Vivid `Atom.isSerializable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isSerializable: (self: Atom<any>) => self is Atom<any> & Serializable<any>;
```

## serializable

Attaches serialization metadata to an atom using a schema and stable key.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3254`.

Vivid `Atom.serializable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const serializable: {
    <R extends Atom<any>, S extends Schema.ConstraintCodec<Type<R>, any>>(options: {
        readonly key: string;
        readonly schema: S;
    }): (self: R) => R & Serializable<S>;
    <R extends Atom<any>, S extends Schema.ConstraintCodec<Type<R>, any>>(self: R, options: {
        readonly key: string;
        readonly schema: S;
    }): R & Serializable<S>;
};
```

## ServerValueTypeId

The type id used to mark atoms with a server-side read override.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3315`.

Vivid `Atom.ServerValueTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const ServerValueTypeId: "~effect-atom/atom/Atom/ServerValue";
```

## withServerValue

Sets the value of an Atom when read on the server.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3324`.

Vivid `Atom.withServerValue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withServerValue: {
    <A extends Atom<any>>(read: (get: <A>(atom: Atom<A>) => A) => Type<A>): (self: A) => A;
    <A extends Atom<any>>(self: A, read: (get: <A>(atom: Atom<A>) => A) => Type<A>): A;
};
```

## withServerValueInitial

Sets an `AsyncResult` atom's server-side value to `AsyncResult.initial(true)`.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3358`.

Vivid `Atom.withServerValueInitial` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withServerValueInitial: <A extends Atom<AsyncResult.AsyncResult<any, any>>>(self: A) => A;
```

## getServerValue

Reads an atom from a registry, using its server-side read override when one is present.

Source: `effect@4.0.2/src/reactivity/Atom.ts:3373`.

Vivid `Atom.getServerValue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getServerValue: {
    (registry: Registry.AtomRegistry): <A>(self: Atom<A>) => A;
    <A>(self: Atom<A>, registry: Registry.AtomRegistry): A;
};
```
