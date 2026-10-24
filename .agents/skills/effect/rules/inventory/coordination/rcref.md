# RcRef

Import `effect/RcRef`. Source `effect@4.0.2/src/RcRef.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## RcRef

Namespace containing type-level members associated with `RcRef`.

Source: `effect@4.0.2/src/RcRef.ts:90`.

Vivid `RcRef.RcRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface RcRef<out A, out E = never> extends Pipeable {
    readonly [TypeId]: RcRef.Variance<A, E>;
}
export declare namespace RcRef {
    interface Variance<A, E> {
        readonly _A: Types.Covariant<A>;
        readonly _E: Types.Covariant<E>;
    }
}
```

## make

Creates an `RcRef` from an acquire effect.

Source: `effect@4.0.2/src/RcRef.ts:161`.

Vivid `RcRef.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A, E, R>(options: {
    readonly acquire: Effect.Effect<A, E, R>;
    readonly idleTimeToLive?: Duration.Input | undefined;
}) => Effect.Effect<RcRef<A, E>, never, R | Scope>;
```

## get

Gets the value from an `RcRef`, acquiring it first if needed.

Source: `effect@4.0.2/src/RcRef.ts:225`.

Vivid `RcRef.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A, E>(self: RcRef<A, E>) => Effect.Effect<A, E, Scope>;
```

## invalidate

Invalidates the currently cached resource, if one has been acquired.

Source: `effect@4.0.2/src/RcRef.ts:250`.

Vivid `RcRef.invalidate` matches: 0. No qualified match. Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const invalidate: <A, E>(self: RcRef<A, E>) => Effect.Effect<void>;
```
