# AtomRef

Import `effect/reactivity/AtomRef`. Source `effect@4.0.2/src/reactivity/AtomRef.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 6. Module-name matches in Vivid: 0. No bare-name match.

## TypeId

The runtime type id used to identify `AtomRef` values.

Source: `effect@4.0.2/src/reactivity/AtomRef.ts:32`.

Vivid `AtomRef.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type TypeId = "~effect/reactivity/AtomRef";
export declare const TypeId: TypeId;
```

## ReadonlyRef

A read-only reactive reference.

Source: `effect@4.0.2/src/reactivity/AtomRef.ts:47`.

Vivid `AtomRef.ReadonlyRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ReadonlyRef<A> extends Equal.Equal {
    readonly [TypeId]: TypeId;
    readonly key: string;
    readonly value: A;
    readonly subscribe: (f: (a: A) => void) => () => void;
    readonly map: <B>(f: (a: A) => B) => ReadonlyRef<B>;
}
```

## AtomRef

A mutable reactive reference.

Source: `effect@4.0.2/src/reactivity/AtomRef.ts:67`.

Vivid `AtomRef.AtomRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AtomRef<A> extends ReadonlyRef<A> {
    readonly prop: <K extends keyof A>(prop: K) => AtomRef<A[K]>;
    readonly set: (value: A) => AtomRef<A>;
    readonly update: (f: (value: A) => A) => AtomRef<A>;
}
```

## Collection

A reactive collection of mutable item references.

Source: `effect@4.0.2/src/reactivity/AtomRef.ts:85`.

Vivid `AtomRef.Collection` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Collection<A> extends ReadonlyRef<ReadonlyArray<AtomRef<A>>> {
    readonly push: (item: A) => Collection<A>;
    readonly insertAt: (index: number, item: A) => Collection<A>;
    readonly remove: (ref: AtomRef<A>) => Collection<A>;
    readonly toArray: () => Array<A>;
}
```

## make

Creates a mutable reactive reference initialized with the supplied value.

Source: `effect@4.0.2/src/reactivity/AtomRef.ts:99`.

Vivid `AtomRef.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(value: A) => AtomRef<A>;
```

## collection

Creates a reactive collection from an iterable of initial item values.

Source: `effect@4.0.2/src/reactivity/AtomRef.ts:113`.

Vivid `AtomRef.collection` matches: 0. No qualified match. Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const collection: <A>(items: Iterable<A>) => Collection<A>;
```
