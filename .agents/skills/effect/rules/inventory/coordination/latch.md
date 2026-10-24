# Latch

Import `effect/Latch`. Source `effect@4.0.2/src/Latch.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 11. Module-name matches in Vivid: 9. apps/server/src/code/process.ts:343, apps/server/src/live/changes.ts:8, apps/server/src/live/changes.ts:226

## Latch

A reusable coordination primitive that lets fibers wait until they are released by the latch.

Source: `effect@4.0.2/src/Latch.ts:54`.

Vivid `Latch.Latch` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export interface Latch {
    readonly open: Effect.Effect<boolean>;
    openUnsafe(this: Latch): boolean;
    readonly release: Effect.Effect<boolean>;
    readonly await: Effect.Effect<void>;
    readonly close: Effect.Effect<boolean>;
    closeUnsafe(this: Latch): boolean;
    whenOpen<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
    isOpen(this: Latch): boolean;
}
```

## makeUnsafe

Creates a `Latch` synchronously, outside of `Effect`.

Source: `effect@4.0.2/src/Latch.ts:164`.

Vivid `Latch.makeUnsafe` matches: 4. packages/agent/runtime/src/notes.test.ts:340, packages/agent/runtime/src/notes.test.ts:414, packages/agent/runtime/src/notes.test.ts:474 Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: (open?: boolean | undefined) => Latch;
```

## make

Creates a `Latch` inside `Effect`.

Source: `effect@4.0.2/src/Latch.ts:200`.

Vivid `Latch.make` matches: 1. apps/server/src/live/changes.ts:226 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (open?: boolean | undefined) => Effect.Effect<Latch>;
```

## open

Opens the latch and releases fibers waiting on it.

Source: `effect@4.0.2/src/Latch.ts:221`.

Vivid `Latch.open` matches: 0. No qualified match. Bare-name matches: 1079. Aliased usage is unverified.

```ts
export declare const open: (self: Latch) => Effect.Effect<boolean>;
```

## openUnsafe

Opens the latch synchronously and releases fibers waiting on it.

Source: `effect@4.0.2/src/Latch.ts:245`.

Vivid `Latch.openUnsafe` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const openUnsafe: (self: Latch) => boolean;
```

## release

Releases the fibers currently waiting on a closed latch without opening it.

Source: `effect@4.0.2/src/Latch.ts:267`.

Vivid `Latch.release` matches: 0. No qualified match. Bare-name matches: 270. Aliased usage is unverified.

```ts
export declare const release: (self: Latch) => Effect.Effect<boolean>;
```

## await

Waits for the latch to be opened.

Source: `effect@4.0.2/src/Latch.ts:298`.

Vivid `Latch.await` matches: 0. No qualified match. Bare-name matches: 395. Aliased usage is unverified.

```ts
declare const _await: (self: Latch) => Effect.Effect<void>;
export { _await as await };
```

## close

Closes the latch so future `await` and `whenOpen` calls suspend.

Source: `effect@4.0.2/src/Latch.ts:321`.

Vivid `Latch.close` matches: 0. No qualified match. Bare-name matches: 453. Aliased usage is unverified.

```ts
export declare const close: (self: Latch) => Effect.Effect<boolean>;
```

## closeUnsafe

Closes the latch synchronously so future `await` and `whenOpen` calls suspend.

Source: `effect@4.0.2/src/Latch.ts:346`.

Vivid `Latch.closeUnsafe` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const closeUnsafe: (self: Latch) => boolean;
```

## whenOpen

Waits on the latch, then runs the provided effect.

Source: `effect@4.0.2/src/Latch.ts:371`.

Vivid `Latch.whenOpen` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const whenOpen: {
    (self: Latch): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    <A, E, R>(self: Latch, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
};
```

## isOpen

Checks whether the latch is currently open or closed.

Source: `effect@4.0.2/src/Latch.ts:440`.

Vivid `Latch.isOpen` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isOpen: (self: Latch) => boolean;
```
