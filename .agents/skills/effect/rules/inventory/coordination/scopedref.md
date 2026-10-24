# ScopedRef

Import `effect/ScopedRef`. Source `effect@4.0.2/src/ScopedRef.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 6. Module-name matches in Vivid: 0. No bare-name match.

## ScopedRef

A `ScopedRef` is a reference whose value is associated with resources, which must be released properly. You can both get the current value of any `ScopedRef`, as well as set it to a new value (which may require new resources). The reference itself takes care of properly releasing resources for the old value whenever a new value is obtained.

Source: `effect@4.0.2/src/ScopedRef.ts:40`.

Vivid `ScopedRef.ScopedRef` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ScopedRef<in out A> extends Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly backing: Synchronized.SynchronizedRef<readonly [
        Scope.Closeable,
        A
    ]>;
}
```

## fromAcquire

Creates a new `ScopedRef` from an effect that acquires the initial value.

Source: `effect@4.0.2/src/ScopedRef.ts:87`.

Vivid `ScopedRef.fromAcquire` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromAcquire: <A, E, R>(acquire: Effect.Effect<A, E, R>) => Effect.Effect<ScopedRef<A>, E, Scope.Scope | R>;
```

## getUnsafe

Retrieves the current value of the scoped reference synchronously.

Source: `effect@4.0.2/src/ScopedRef.ts:116`.

Vivid `ScopedRef.getUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getUnsafe: <A>(self: ScopedRef<A>) => A;
```

## get

Retrieves the current value of the scoped reference effectfully.

Source: `effect@4.0.2/src/ScopedRef.ts:132`.

Vivid `ScopedRef.get` matches: 0. No qualified match. Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A>(self: ScopedRef<A>) => Effect.Effect<A>;
```

## make

Creates a new `ScopedRef` from the specified value.

Source: `effect@4.0.2/src/ScopedRef.ts:160`.

Vivid `ScopedRef.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(evaluate: LazyArg<A>) => Effect.Effect<ScopedRef<A>, never, Scope.Scope>;
```

## set

Sets the value of this reference to a newly acquired scoped value, releasing any resources associated with the old value.

Source: `effect@4.0.2/src/ScopedRef.ts:182`.

Vivid `ScopedRef.set` matches: 0. No qualified match. Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: {
    <A, R, E>(acquire: Effect.Effect<A, E, R>): (self: ScopedRef<A>) => Effect.Effect<void, E, Exclude<R, Scope.Scope>>;
    <A, R, E>(self: ScopedRef<A>, acquire: Effect.Effect<A, E, R>): Effect.Effect<void, E, Exclude<R, Scope.Scope>>;
};
```
