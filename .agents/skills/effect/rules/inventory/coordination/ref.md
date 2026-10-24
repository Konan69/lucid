# Ref

Import `effect/Ref`. Source `effect@4.0.2/src/Ref.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 16. Module-name matches in Vivid: 1605. apps/desktop/src/main/control.ts:7, apps/desktop/src/main/control.ts:562, apps/desktop/src/main/control.ts:655

## Ref

The Ref namespace containing type definitions and utilities.

Source: `effect@4.0.2/src/Ref.ts:75`.

Vivid `Ref.Ref` matches: 127. apps/desktop/src/main/control.ts:562, apps/server/src/approvals/testing.ts:67, apps/server/src/approvals/testing.ts:68 Bare-name matches: 1605. Aliased usage is unverified.

```ts
export interface Ref<in out A> extends Ref.Variance<A>, Pipeable {
    readonly ref: MutableRef.MutableRef<A>;
}
export declare namespace Ref {
    interface Variance<in out A> {
        readonly [TypeId]: {
            readonly _A: Invariant<A>;
        };
    }
}
```

## makeUnsafe

Creates a new Ref with the specified initial value (unsafe version).

Source: `effect@4.0.2/src/Ref.ts:146`.

Vivid `Ref.makeUnsafe` matches: 0. No qualified match. Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: <A>(value: A) => Ref<A>;
```

## make

Creates a new Ref with the specified initial value.

Source: `effect@4.0.2/src/Ref.ts:178`.

Vivid `Ref.make` matches: 211. apps/desktop/src/main/control.ts:819, apps/desktop/src/main/settings.ts:183, apps/server/src/approvals/testing.ts:92 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A>(value: A) => Effect.Effect<Ref<A>>;
```

## get

Gets the current value of the Ref.

Source: `effect@4.0.2/src/Ref.ts:206`.

Vivid `Ref.get` matches: 650. apps/desktop/src/main/control.ts:655, apps/desktop/src/main/settings.ts:196, apps/server/src/approvals/gate.test.ts:128 Bare-name matches: 1442. Aliased usage is unverified.

```ts
export declare const get: <A>(self: Ref<A>) => Effect.Effect<A, never, never>;
```

## set

Sets the value of the Ref to the specified value.

Source: `effect@4.0.2/src/Ref.ts:243`.

Vivid `Ref.set` matches: 360. apps/desktop/src/main/control.ts:738, apps/desktop/src/main/control.ts:749, apps/desktop/src/main/settings.ts:189 Bare-name matches: 1008. Aliased usage is unverified.

```ts
export declare const set: (<A>(value: A) => (self: Ref<A>) => Effect.Effect<void>) & (<A>(self: Ref<A>, value: A) => Effect.Effect<void>);
```

## getAndSet

Gets the current value of the Ref, sets it to the specified value, and returns the previous value atomically.

Source: `effect@4.0.2/src/Ref.ts:348`.

Vivid `Ref.getAndSet` matches: 7. apps/server/src/channels/testing.ts:125, apps/server/src/computers/boat.test.ts:583, apps/server/src/http/upload.test.ts:71 Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const getAndSet: (<A>(value: A) => (self: Ref<A>) => Effect.Effect<A>) & (<A>(self: Ref<A>, value: A) => Effect.Effect<A>);
```

## getAndUpdate

Gets the current value of the Ref, updates it with the given function, and returns the previous value atomically.

Source: `effect@4.0.2/src/Ref.ts:448`.

Vivid `Ref.getAndUpdate` matches: 5. apps/server/src/channels/worker.test.ts:24, apps/server/src/memory/once.test.ts:352, apps/server/src/memory/once.test.ts:776 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const getAndUpdate: (<A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<A>) & (<A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<A>);
```

## getAndUpdateSome

Gets the current value of the Ref and updates it atomically with the given partial function.

Source: `effect@4.0.2/src/Ref.ts:562`.

Vivid `Ref.getAndUpdateSome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getAndUpdateSome: (<A>(pf: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<A>) & (<A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) => Effect.Effect<A>);
```

## setAndGet

Sets the value of the Ref atomically to the specified value and returns the new value.

Source: `effect@4.0.2/src/Ref.ts:697`.

Vivid `Ref.setAndGet` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setAndGet: (<A>(value: A) => (self: Ref<A>) => Effect.Effect<A>) & (<A>(self: Ref<A>, value: A) => Effect.Effect<A>);
```

## modify

Modifies the value of the Ref atomically using the given function.

Source: `effect@4.0.2/src/Ref.ts:819`.

Vivid `Ref.modify` matches: 9. apps/server/src/connections/executor.ts:1723, apps/server/src/connections/executor.ts:1892, apps/server/src/connections/testing.ts:573 Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const modify: (<A, B>(f: (a: A) => readonly [
    B,
    A
]) => (self: Ref<A>) => Effect.Effect<B>) & (<A, B>(self: Ref<A>, f: (a: A) => readonly [
    B,
    A
]) => Effect.Effect<B>);
```

## modifySome

Computes a result atomically and optionally updates the value of the `Ref`.

Source: `effect@4.0.2/src/Ref.ts:978`.

Vivid `Ref.modifySome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const modifySome: {
    <B, A>(pf: (a: A) => readonly [
        B,
        Option.Option<A>
    ]): (self: Ref<A>) => Effect.Effect<B>;
    <A, B>(self: Ref<A>, pf: (a: A) => readonly [
        B,
        Option.Option<A>
    ]): Effect.Effect<B>;
};
```

## update

Updates the value of the Ref atomically using the given function.

Source: `effect@4.0.2/src/Ref.ts:1230`.

Vivid `Ref.update` matches: 140. apps/server/src/approvals/testing.ts:117, apps/server/src/approvals/testing.ts:137, apps/server/src/approvals/testing.ts:144 Bare-name matches: 531. Aliased usage is unverified.

```ts
export declare const update: (<A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<void>) & (<A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<void>);
```

## updateAndGet

Updates the value of the Ref atomically using the given function and returns the new value.

Source: `effect@4.0.2/src/Ref.ts:1340`.

Vivid `Ref.updateAndGet` matches: 15. apps/server/src/code/calls.test.ts:526, apps/server/src/code/calls.test.ts:1035, apps/server/src/code/computer.live.test.ts:93 Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const updateAndGet: (<A>(f: (a: A) => A) => (self: Ref<A>) => Effect.Effect<A>) & (<A>(self: Ref<A>, f: (a: A) => A) => Effect.Effect<A>);
```

## updateSome

Updates the value of the Ref atomically using the given partial function.

Source: `effect@4.0.2/src/Ref.ts:1449`.

Vivid `Ref.updateSome` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSome: (<A>(f: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<void>) & (<A>(self: Ref<A>, f: (a: A) => Option.Option<A>) => Effect.Effect<void>);
```

## updateSomeAndGet

Updates the value of the Ref atomically using the given partial function and returns the current value.

Source: `effect@4.0.2/src/Ref.ts:1591`.

Vivid `Ref.updateSomeAndGet` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateSomeAndGet: (<A>(pf: (a: A) => Option.Option<A>) => (self: Ref<A>) => Effect.Effect<A>) & (<A>(self: Ref<A>, pf: (a: A) => Option.Option<A>) => Effect.Effect<A>);
```

## getUnsafe

Gets the current value of the Ref synchronously (unsafe version).

Source: `effect@4.0.2/src/Ref.ts:1714`.

Vivid `Ref.getUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getUnsafe: <A>(self: Ref<A>) => A;
```
