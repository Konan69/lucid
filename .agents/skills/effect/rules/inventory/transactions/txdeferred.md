# TxDeferred

Import `effect/TxDeferred`. Source `effect@4.0.2/src/TxDeferred.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 8. Module-name matches in Vivid: 0. No bare-name match.

## TxDeferred

A transactional deferred is a write-once cell readable within transactions. Readers block (retry the transaction) until a value is committed, and writers succeed only on the first call; subsequent writes return `false`.

Source: `effect@4.0.2/src/TxDeferred.ts:65`.

Vivid `TxDeferred.TxDeferred` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface TxDeferred<in out A, in out E = never> extends Inspectable, Pipeable {
    readonly [TypeId]: typeof TypeId;
    readonly ref: TxRef.TxRef<Option<Result<A, E>>>;
}
```

## make

Creates a new empty `TxDeferred`.

Source: `effect@4.0.2/src/TxDeferred.ts:115`.

Vivid `TxDeferred.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A, E = never>() => Effect.Effect<TxDeferred<A, E>>;
```

## await

Reads the deferred value. Retries the transaction if the deferred has not been completed yet.

Source: `effect@4.0.2/src/TxDeferred.ts:166`.

Vivid `TxDeferred.await` matches: 0. No qualified match. Bare-name matches: 395. Aliased usage is unverified.

```ts
declare const await_: <A, E>(self: TxDeferred<A, E>) => Effect.Effect<A, E>;
export { await_ as await };
```

## poll

Reads the current state of the deferred without retrying. Returns `None` if not yet completed.

Source: `effect@4.0.2/src/TxDeferred.ts:198`.

Vivid `TxDeferred.poll` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const poll: <A, E>(self: TxDeferred<A, E>) => Effect.Effect<Option<Result<A, E>>>;
```

## done

Completes the deferred with a `Result`. Returns `true` if this was the first completion, `false` if already completed.

Source: `effect@4.0.2/src/TxDeferred.ts:227`.

Vivid `TxDeferred.done` matches: 0. No qualified match. Bare-name matches: 433. Aliased usage is unverified.

```ts
export declare const done: {
    <A, E>(result: Result<A, E>): (self: TxDeferred<A, E>) => Effect.Effect<boolean>;
    <A, E>(self: TxDeferred<A, E>, result: Result<A, E>): Effect.Effect<boolean>;
};
```

## succeed

Completes the deferred with a success value. Returns `true` if this was the first completion, `false` if already completed.

Source: `effect@4.0.2/src/TxDeferred.ts:322`.

Vivid `TxDeferred.succeed` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const succeed: {
    <A>(value: A): <E>(self: TxDeferred<A, E>) => Effect.Effect<boolean>;
    <A, E>(self: TxDeferred<A, E>, value: A): Effect.Effect<boolean>;
};
```

## fail

Completes the deferred with a failure. Returns `true` if this was the first completion, `false` if already completed.

Source: `effect@4.0.2/src/TxDeferred.ts:412`.

Vivid `TxDeferred.fail` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: {
    <E>(error: E): <A>(self: TxDeferred<A, E>) => Effect.Effect<boolean>;
    <A, E>(self: TxDeferred<A, E>, error: E): Effect.Effect<boolean>;
};
```

## isTxDeferred

Determines if the provided value is a `TxDeferred`.

Source: `effect@4.0.2/src/TxDeferred.ts:500`.

Vivid `TxDeferred.isTxDeferred` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTxDeferred: (u: unknown) => u is TxDeferred<unknown, unknown>;
```
