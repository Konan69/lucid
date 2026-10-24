# Exit

Import `effect/Exit`. Source `effect@4.0.2/src/Exit.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 30. Module-name matches in Vivid: 143. apps/desktop/src/main/computer.ts:48, apps/desktop/src/main/installation.test.ts:6, apps/desktop/src/main/installation.test.ts:63

## Exit

Namespace containing helper types shared by `Exit` values.

Source: `effect@4.0.2/src/Exit.ts:74`.

Vivid `Exit.Exit` matches: 6. apps/server/src/computers/device.test.ts:462, apps/server/src/connections/executor.ts:2192, apps/server/src/connections/store.ts:497 Bare-name matches: 143. Aliased usage is unverified.

```ts
export type Exit<A, E = never> = Success<A, E> | Failure<A, E>;
export declare namespace Exit {
    interface Proto<out A, out E = never> extends Effect.Effect<A, E> {
        readonly [TypeId]: typeof TypeId;
    }
}
```

## Success

A successful Exit containing a value.

Source: `effect@4.0.2/src/Exit.ts:122`.

Vivid `Exit.Success` matches: 0. No qualified match. Bare-name matches: 102. Aliased usage is unverified.

```ts
export interface Success<out A, out E = never> extends Exit.Proto<A, E> {
    readonly _tag: "Success";
    readonly value: A;
}
```

## Failure

A failed Exit containing a Cause.

Source: `effect@4.0.2/src/Exit.ts:159`.

Vivid `Exit.Failure` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export interface Failure<out A, out E> extends Exit.Proto<A, E> {
    readonly _tag: "Failure";
    readonly cause: Cause.Cause<E>;
}
```

## isExit

Checks whether an unknown value is an Exit.

Source: `effect@4.0.2/src/Exit.ts:194`.

Vivid `Exit.isExit` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isExit: (u: unknown) => u is Exit<unknown, unknown>;
```

## succeed

Creates a successful Exit containing the given value.

Source: `effect@4.0.2/src/Exit.ts:223`.

Vivid `Exit.succeed` matches: 20. apps/server/src/computers/shell.test.ts:197, apps/server/src/connections/effects.ts:320, apps/server/src/feed/store.test.ts:457 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const succeed: <A>(a: A) => Exit<A>;
```

## failCause

Creates a failed Exit from a Cause.

Source: `effect@4.0.2/src/Exit.ts:254`.

Vivid `Exit.failCause` matches: 2. apps/server/src/computers/handlers.ts:84, apps/server/src/observability/guard.ts:434 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const failCause: <E>(cause: Cause.Cause<E>) => Exit<never, E>;
```

## fail

Creates a failed Exit from a typed error value.

Source: `effect@4.0.2/src/Exit.ts:285`.

Vivid `Exit.fail` matches: 1. apps/server/src/connections/effects.ts:319 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: <E>(e: E) => Exit<never, E>;
```

## die

Creates a failed Exit from a defect (unexpected error).

Source: `effect@4.0.2/src/Exit.ts:317`.

Vivid `Exit.die` matches: 0. No qualified match. Bare-name matches: 95. Aliased usage is unverified.

```ts
export declare const die: (defect: unknown) => Exit<never>;
```

## interrupt

Creates a failed Exit representing fiber interruption.

Source: `effect@4.0.2/src/Exit.ts:345`.

Vivid `Exit.interrupt` matches: 0. No qualified match. Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const interrupt: (fiberId?: number | undefined) => Exit<never>;
```

## void

Provides a pre-allocated successful Exit with a `void` value.

Source: `effect@4.0.2/src/Exit.ts:376`.

Vivid `Exit.void` matches: 17. apps/desktop/src/main/main.ts:230, apps/desktop/src/main/main.ts:381, apps/desktop/src/main/turn.ts:191 Bare-name matches: 1605. Aliased usage is unverified.

```ts
declare const void_: Exit<void>;
export { void_ as void };
```

## isSuccess

Checks whether an Exit is a Success.

Source: `effect@4.0.2/src/Exit.ts:406`.

Vivid `Exit.isSuccess` matches: 29. apps/server/src/code/process.ts:246, apps/server/src/code/source.ts:195, apps/server/src/computers/boat/state.ts:65 Bare-name matches: 137. Aliased usage is unverified.

```ts
export declare const isSuccess: <A, E>(self: Exit<A, E>) => self is Success<A, E>;
```

## isFailure

Checks whether an Exit is a Failure.

Source: `effect@4.0.2/src/Exit.ts:435`.

Vivid `Exit.isFailure` matches: 13. apps/desktop/src/main/installation.test.ts:63, apps/server/src/approvals/replay.test.ts:132, apps/server/src/approvals/replay.test.ts:295 Bare-name matches: 197. Aliased usage is unverified.

```ts
export declare const isFailure: <A, E>(self: Exit<A, E>) => self is Failure<A, E>;
```

## hasFails

Checks whether a failed Exit contains typed errors (Fail reasons).

Source: `effect@4.0.2/src/Exit.ts:466`.

Vivid `Exit.hasFails` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const hasFails: <A, E>(self: Exit<A, E>) => self is Failure<A, E>;
```

## hasDies

Checks whether a failed Exit contains defects (Die reasons).

Source: `effect@4.0.2/src/Exit.ts:497`.

Vivid `Exit.hasDies` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const hasDies: <A, E>(self: Exit<A, E>) => self is Failure<A, E>;
```

## hasInterrupts

Checks whether a failed Exit contains interruptions (Interrupt reasons).

Source: `effect@4.0.2/src/Exit.ts:528`.

Vivid `Exit.hasInterrupts` matches: 3. apps/server/src/computers/device.test.ts:1251, apps/server/src/live/tally.ts:161, packages/agent/runtime/src/notes.test.ts:459 Bare-name matches: 8. Aliased usage is unverified.

```ts
export declare const hasInterrupts: <A, E>(self: Exit<A, E>) => self is Failure<A, E>;
```

## filterSuccess

Extracts the Success variant from an Exit as a Result.

Source: `effect@4.0.2/src/Exit.ts:563`.

Vivid `Exit.filterSuccess` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterSuccess: <A, E>(self: Exit<A, E>) => Result.Result<Success<A>, Failure<never, E>>;
```

## filterValue

Extracts the success value from an Exit as a Result.

Source: `effect@4.0.2/src/Exit.ts:601`.

Vivid `Exit.filterValue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterValue: <A, E>(self: Exit<A, E>) => Result.Result<A, Failure<never, E>>;
```

## filterFailure

Extracts the Failure variant from an Exit as a Result.

Source: `effect@4.0.2/src/Exit.ts:636`.

Vivid `Exit.filterFailure` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterFailure: <A, E>(self: Exit<A, E>) => Result.Result<Failure<never, E>, Success<A>>;
```

## filterCause

Extracts the Cause from a failed Exit as a Result.

Source: `effect@4.0.2/src/Exit.ts:672`.

Vivid `Exit.filterCause` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterCause: <A, E>(self: Exit<A, E>) => Result.Result<Cause.Cause<E>, Success<A>>;
```

## findError

Extracts the first typed error value from a failed Exit as a Result.

Source: `effect@4.0.2/src/Exit.ts:708`.

Vivid `Exit.findError` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const findError: <A, E>(input: Exit<A, E>) => Result.Result<E, Exit<A, E>>;
```

## findDefect

Extracts the first defect from a failed Exit as a Result.

Source: `effect@4.0.2/src/Exit.ts:744`.

Vivid `Exit.findDefect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const findDefect: <A, E>(input: Exit<A, E>) => Result.Result<unknown, Exit<A, E>>;
```

## match

Pattern matches on an Exit, handling both success and failure cases.

Source: `effect@4.0.2/src/Exit.ts:776`.

Vivid `Exit.match` matches: 5. apps/server/src/decisions/model.ts:585, apps/server/src/library/durability.test.ts:458, apps/server/src/library/extraction.test.ts:49 Bare-name matches: 790. Aliased usage is unverified.

```ts
export declare const match: {
    <A, E, X1, X2>(options: {
        readonly onSuccess: (a: NoInfer<A>) => X1;
        readonly onFailure: (cause: Cause.Cause<NoInfer<E>>) => X2;
    }): (self: Exit<A, E>) => X1 | X2;
    <A, E, X1, X2>(self: Exit<A, E>, options: {
        readonly onSuccess: (a: A) => X1;
        readonly onFailure: (cause: Cause.Cause<E>) => X2;
    }): X1 | X2;
};
```

## map

Transforms the success value of an Exit using the given function.

Source: `effect@4.0.2/src/Exit.ts:880`.

Vivid `Exit.map` matches: 0. No qualified match. Bare-name matches: 1501. Aliased usage is unverified.

```ts
export declare const map: {
    <A, B>(f: (a: A) => B): <E>(self: Exit<A, E>) => Exit<B, E>;
    <A, E, B>(self: Exit<A, E>, f: (a: A) => B): Exit<B, E>;
};
```

## mapError

Transforms the typed error of a failed Exit using the given function.

Source: `effect@4.0.2/src/Exit.ts:974`.

Vivid `Exit.mapError` matches: 0. No qualified match. Bare-name matches: 250. Aliased usage is unverified.

```ts
export declare const mapError: {
    <E, E2>(f: (a: NoInfer<E>) => E2): <A>(self: Exit<A, E>) => Exit<A, E2>;
    <A, E, E2>(self: Exit<A, E>, f: (a: NoInfer<E>) => E2): Exit<A, E2>;
};
```

## mapBoth

Transforms both the success value and typed error of an Exit.

Source: `effect@4.0.2/src/Exit.ts:1081`.

Vivid `Exit.mapBoth` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapBoth: {
    <E, E2, A, A2>(options: {
        readonly onFailure: (e: E) => E2;
        readonly onSuccess: (a: A) => A2;
    }): (self: Exit<A, E>) => Exit<A2, E2>;
    <A, E, E2, A2>(self: Exit<A, E>, options: {
        readonly onFailure: (e: E) => E2;
        readonly onSuccess: (a: A) => A2;
    }): Exit<A2, E2>;
};
```

## asVoid

Discards the success value of an Exit, replacing it with `void`.

Source: `effect@4.0.2/src/Exit.ts:1192`.

Vivid `Exit.asVoid` matches: 0. No qualified match. Bare-name matches: 85. Aliased usage is unverified.

```ts
export declare const asVoid: <A, E>(self: Exit<A, E>) => Exit<void, E>;
```

## asVoidAll

Combines multiple Exit values into a single `Exit<void, E>`.

Source: `effect@4.0.2/src/Exit.ts:1224`.

Vivid `Exit.asVoidAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const asVoidAll: <I extends Iterable<Exit<any, any>>>(exits: I) => Exit<void, I extends Iterable<Exit<infer _A, infer _E>> ? _E : never>;
```

## getSuccess

Returns the success value of an Exit as an Option.

Source: `effect@4.0.2/src/Exit.ts:1256`.

Vivid `Exit.getSuccess` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const getSuccess: <A, E>(self: Exit<A, E>) => Option<A>;
```

## getCause

Returns the Cause of a failed Exit as an Option.

Source: `effect@4.0.2/src/Exit.ts:1286`.

Vivid `Exit.getCause` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const getCause: <A, E>(self: Exit<A, E>) => Option<Cause.Cause<E>>;
```

## findErrorOption

Returns the first typed error from a failed Exit as an Option.

Source: `effect@4.0.2/src/Exit.ts:1323`.

Vivid `Exit.findErrorOption` matches: 1. apps/server/src/computers/device.test.ts:464 Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const findErrorOption: <A, E>(self: Exit<A, E>) => Option<E>;
```
