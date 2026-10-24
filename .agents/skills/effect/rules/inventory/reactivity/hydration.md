# Hydration

Import `effect/reactivity/Hydration`. Source `effect@4.0.2/src/reactivity/Hydration.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 5. Module-name matches in Vivid: 0. No bare-name match.

## DehydratedAtom

Marker interface for entries in a dehydrated atom registry state.

Source: `effect@4.0.2/src/reactivity/Hydration.ts:26`.

Vivid `Hydration.DehydratedAtom` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DehydratedAtom {
    readonly "~effect/reactivity/Hydration/DehydratedAtom": true;
}
```

## DehydratedAtomValue

A dehydrated serializable atom value.

Source: `effect@4.0.2/src/reactivity/Hydration.ts:43`.

Vivid `Hydration.DehydratedAtomValue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DehydratedAtomValue extends DehydratedAtom {
    readonly key: string;
    readonly value: unknown;
    readonly dehydratedAt: number;
    readonly resultPromise?: Promise<unknown> | undefined;
}
```

## dehydrate

Encodes the serializable atoms currently stored in a registry into dehydrated state.

Source: `effect@4.0.2/src/reactivity/Hydration.ts:80`.

Vivid `Hydration.dehydrate` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dehydrate: (registry: AtomRegistry.AtomRegistry, options?: {
    readonly encodeInitialAs?: "ignore" | "promise" | "value-only" | undefined;
}) => Array<DehydratedAtom>;
```

## toValues

Returns dehydrated state entries as `DehydratedAtomValue` records.

Source: `effect@4.0.2/src/reactivity/Hydration.ts:132`.

Vivid `Hydration.toValues` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toValues: (state: ReadonlyArray<DehydratedAtom>) => Array<DehydratedAtomValue>;
```

## hydrate

Applies dehydrated atom state to a registry.

Source: `effect@4.0.2/src/reactivity/Hydration.ts:152`.

Vivid `Hydration.hydrate` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const hydrate: (registry: AtomRegistry.AtomRegistry, dehydratedState: Iterable<DehydratedAtom>) => void;
```
