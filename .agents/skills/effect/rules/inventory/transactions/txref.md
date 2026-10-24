# TxRef

Import `effect/TxRef`. Source `effect@4.0.2/src/TxRef.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 7. Module-name matches in Vivid: 0. No bare-name match.

## TxRef

TxRef is a transactional value, it can be read and modified within the body of a transaction.

Source: `effect@4.0.2/src/TxRef.ts:63`.

Vivid `TxRef.TxRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TxRef<in out A> extends Pipeable {
    readonly [TypeId]: typeof TypeId;
    version: number;
    pending: Map<unknown, () => void>;
    value: A;
}
```

## make

Creates a new `TxRef` with the specified initial value.

Source: `effect@4.0.2/src/TxRef.ts:104`.

Vivid `TxRef.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(initial: A) => Effect.Effect<TxRef<A>, never, never>;
```

## makeUnsafe

Creates a new `TxRef` synchronously with the specified initial value.

Source: `effect@4.0.2/src/TxRef.ts:132`.

Vivid `TxRef.makeUnsafe` matches: 0. No qualified match. Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: <A>(initial: A) => TxRef<A>;
```

## modify

Modifies the value of the `TxRef` using the provided function.

Source: `effect@4.0.2/src/TxRef.ts:180`.

Vivid `TxRef.modify` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const modify: {
    <A, R>(f: (current: NoInfer<A>) => [
        returnValue: R,
        newValue: A
    ]): (self: TxRef<A>) => Effect.Effect<R>;
    <A, R>(self: TxRef<A>, f: (current: A) => [
        returnValue: R,
        newValue: A
    ]): Effect.Effect<R>;
};
```

## update

Updates the value of the `TxRef` using the provided function.

Source: `effect@4.0.2/src/TxRef.ts:288`.

Vivid `TxRef.update` matches: 0. No qualified match. Bare-name matches: 531. Aliased usage is unverified.

```ts
export declare const update: {
    <A>(f: (current: NoInfer<A>) => A): (self: TxRef<A>) => Effect.Effect<void>;
    <A>(self: TxRef<A>, f: (current: A) => A): Effect.Effect<void>;
};
```

## get

Reads the current value of the `TxRef`.

Source: `effect@4.0.2/src/TxRef.ts:386`.

Vivid `TxRef.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A>(self: TxRef<A>) => Effect.Effect<A>;
```

## set

Sets the value of the `TxRef`.

Source: `effect@4.0.2/src/TxRef.ts:422`.

Vivid `TxRef.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <A>(value: A): (self: TxRef<A>) => Effect.Effect<void>;
    <A>(self: TxRef<A>, value: A): Effect.Effect<void>;
};
```
