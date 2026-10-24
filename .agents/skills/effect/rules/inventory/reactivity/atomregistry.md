# AtomRegistry

Import `effect/reactivity/AtomRegistry`. Source `effect@4.0.2/src/reactivity/AtomRegistry.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 11. Module-name matches in Vivid: 18. apps/mobile/src/data/connecting.ts:6, apps/mobile/src/data/connecting.ts:178, apps/mobile/src/data/connecting.ts:324

## TypeId

The runtime type id used to identify `AtomRegistry` services and values.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:45`.

Vivid `AtomRegistry.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type TypeId = "~effect/reactivity/AtomRegistry";
export declare const TypeId: TypeId;
```

## isAtomRegistry

Returns `true` when the value has the `AtomRegistry` type id.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:54`.

Vivid `AtomRegistry.isAtomRegistry` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isAtomRegistry: (u: unknown) => u is AtomRegistry;
```

## AtomRegistry

Service tag for the active atom runtime cache.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:158`.

Vivid `AtomRegistry.AtomRegistry` matches: 8. apps/mobile/src/data/connecting.ts:324, apps/web/src/data/connecting.ts:248, packages/client/state/src/live.ts:185 Bare-name matches: 18. Aliased usage is unverified.

```ts
export interface AtomRegistry {
    readonly [TypeId]: TypeId;
    readonly scheduler: Scheduler;
    readonly schedulerAsync: Scheduler;
    readonly getNodes: () => ReadonlyMap<Atom.Atom<any> | string, Node<any>>;
    readonly ensureNode: <A>(atom: Atom.Atom<A>) => Node<A>;
    readonly get: <A>(atom: Atom.Atom<A>) => A;
    readonly mount: <A>(atom: Atom.Atom<A>) => () => void;
    readonly refresh: <A>(atom: Atom.Atom<A>) => void;
    readonly set: <R, W>(atom: Atom.Writable<R, W>, value: W) => void;
    readonly setSerializable: (key: string, encoded: unknown) => void;
    readonly preloadedSerializable: Map<string, unknown>;
    readonly modify: <R, W, A>(atom: Atom.Writable<R, W>, f: (_: R) => [
        returnValue: A,
        nextValue: W
    ]) => A;
    readonly update: <R, W>(atom: Atom.Writable<R, W>, f: (_: R) => W) => void;
    readonly subscribe: <A>(atom: Atom.Atom<A>, f: (_: A) => void, options?: {
        readonly immediate?: boolean;
    }) => () => void;
    readonly reset: () => void;
    readonly dispose: () => void;
    scheduleNodeRemoval(node: Node<any>): void;
    onNodeAdded?: ((node: Node<any>) => void) | undefined;
    onNodeRemoved?: ((node: Node<any>) => void) | undefined;
}
export declare const AtomRegistry: Context.Service<AtomRegistry, AtomRegistry>;
```

## Node

A registry node for a single atom.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:105`.

Vivid `AtomRegistry.Node` matches: 0. No qualified match. Bare-name matches: 157. Aliased usage is unverified.

```ts
export interface Node<A> {
    readonly atom: Atom.Atom<A>;
    readonly value: () => A;
    readonly valueOption: () => Option.Option<A>;
    readonly canBeRemoved: boolean;
    parents: Set<Node<any>>;
    children: Set<Node<any>>;
    listeners: Set<() => void>;
    currentState(): "uninitialized" | "stale" | "valid" | "removed";
    setInitialValue(value: A): void;
    subscribe(listener: () => void): () => void;
}
```

## make

Creates an `AtomRegistry`.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:131`.

Vivid `AtomRegistry.make` matches: 2. apps/mobile/src/data/door.ts:19, packages/client/state/src/live.ts:370 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options?: {
    readonly initialValues?: Iterable<readonly [
        Atom.Atom<any>,
        any
    ]> | undefined;
    readonly scheduleTask?: ((f: () => void) => () => void) | undefined;
    readonly timeoutResolution?: number | undefined;
    readonly defaultIdleTTL?: number | undefined;
} | undefined) => AtomRegistry;
```

## layerOptions

Creates a layer that provides an `AtomRegistry` configured with the supplied options.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:172`.

Vivid `AtomRegistry.layerOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerOptions: (options?: {
    readonly initialValues?: Iterable<readonly [
        Atom.Atom<any>,
        any
    ]> | undefined;
    readonly scheduleTask?: ((f: () => void) => () => void) | undefined;
    readonly timeoutResolution?: number | undefined;
    readonly defaultIdleTTL?: number | undefined;
}) => Layer.Layer<AtomRegistry>;
```

## layer

The default layer that provides a fresh `AtomRegistry`.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:198`.

Vivid `AtomRegistry.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<AtomRegistry>;
```

## toStream

Converts an atom in this registry into a stream.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:216`.

Vivid `AtomRegistry.toStream` matches: 2. apps/mobile/src/data/connecting.ts:178, apps/web/src/data/connecting.ts:129 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const toStream: {
    <A>(atom: Atom.Atom<A>): (self: AtomRegistry) => Stream.Stream<A>;
    <A>(self: AtomRegistry, atom: Atom.Atom<A>): Stream.Stream<A>;
};
```

## toStreamResult

Converts an `AsyncResult` atom in this registry into a stream of successful values.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:295`.

Vivid `AtomRegistry.toStreamResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toStreamResult: {
    <A, E>(atom: Atom.Atom<Result.AsyncResult<A, E>>): (self: AtomRegistry) => Stream.Stream<A, E>;
    <A, E>(self: AtomRegistry, atom: Atom.Atom<Result.AsyncResult<A, E>>): Stream.Stream<A, E>;
};
```

## getResult

Reads an `AsyncResult` atom from this registry as an effect.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:348`.

Vivid `AtomRegistry.getResult` matches: 1. packages/client/state/src/live.ts:486 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const getResult: {
    <A, E>(atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
        readonly suspendOnWaiting?: boolean | undefined;
    }): (self: AtomRegistry) => Effect.Effect<A, E>;
    <A, E>(self: AtomRegistry, atom: Atom.Atom<Result.AsyncResult<A, E>>, options?: {
        readonly suspendOnWaiting?: boolean | undefined;
    }): Effect.Effect<A, E>;
};
```

## mount

Mounts an atom in this registry for the lifetime of the current scope.

Source: `effect@4.0.2/src/reactivity/AtomRegistry.ts:420`.

Vivid `AtomRegistry.mount` matches: 0. No qualified match. Bare-name matches: 14. Aliased usage is unverified.

```ts
export declare const mount: {
    <A>(atom: Atom.Atom<A>): (self: AtomRegistry) => Effect.Effect<void, never, Scope.Scope>;
    <A>(self: AtomRegistry, atom: Atom.Atom<A>): Effect.Effect<void, never, Scope.Scope>;
};
```
