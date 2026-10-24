# Cause

Import `effect/Cause`. Source `effect@4.0.2/src/Cause.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 65. Module-name matches in Vivid: 109. apps/mobile/src/data/door.ts:1, apps/mobile/src/data/door.ts:56, apps/mobile/src/screen/door/attempt.ts:1

## TypeId

Unique brand for `Cause` values, used for runtime type checks via {@link isCause}.

Source: `effect@4.0.2/src/Cause.ts:33`.

Vivid `Cause.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const TypeId: "~effect/Cause";
```

## ReasonTypeId

Unique brand for `Reason` values, used for runtime type checks via {@link isReason}.

Source: `effect@4.0.2/src/Cause.ts:42`.

Vivid `Cause.ReasonTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const ReasonTypeId: "~effect/Cause/Reason";
```

## Cause

Companion namespace for the `Cause` interface.

Source: `effect@4.0.2/src/Cause.ts:240`.

Vivid `Cause.Cause` matches: 6. apps/server/src/code/process.ts:99, apps/server/src/decisions/model.ts:374, apps/server/src/memory/learn.ts:27 Bare-name matches: 109. Aliased usage is unverified.

```ts
export interface Cause<out E> extends Pipeable, Inspectable, Equal {
    readonly [TypeId]: typeof TypeId;
    readonly reasons: ReadonlyArray<Reason<E>>;
}
export declare namespace Cause {
    type Error<T> = T extends Cause<infer E> ? E : never;
    interface ReasonProto<Tag extends string> extends Inspectable, Equal {
        readonly [ReasonTypeId]: typeof ReasonTypeId;
        readonly _tag: Tag;
        readonly annotations: ReadonlyMap<string, unknown>;
        annotate(annotations: Context.Context<never>, options?: {
            readonly overwrite?: boolean | undefined;
        }): this;
    }
}
```

## isCause

Checks whether an arbitrary value is a `Cause`.

Source: `effect@4.0.2/src/Cause.ts:100`.

Vivid `Cause.isCause` matches: 3. apps/server/src/computers/boat/bindings.ts:29, apps/server/src/database/client.ts:63, apps/server/src/observability/failure.ts:386 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const isCause: (self: unknown) => self is Cause<unknown>;
```

## isReason

Checks whether an arbitrary value is a `Reason` (`Fail`, `Die`, or `Interrupt`).

Source: `effect@4.0.2/src/Cause.ts:119`.

Vivid `Cause.isReason` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isReason: (self: unknown) => self is Reason<unknown>;
```

## Reason

Companion namespace for the `Reason` type.

Source: `effect@4.0.2/src/Cause.ts:287`.

Vivid `Cause.Reason` matches: 1. apps/server/src/observability/guard.ts:359 Bare-name matches: 1. Aliased usage is unverified.

```ts
export type Reason<E> = Fail<E> | Die | Interrupt;
export declare namespace Reason {
    type Error<T> = T extends Reason<infer E> ? E : never;
}
```

## isFailReason

Narrows a `Reason` to `Fail`.

Source: `effect@4.0.2/src/Cause.ts:178`.

Vivid `Cause.isFailReason` matches: 7. apps/server/src/code/process.ts:103, apps/server/src/connections/executor.ts:2195, apps/server/src/database/client.ts:64 Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const isFailReason: <E>(self: Reason<E>) => self is Fail<E>;
```

## isDieReason

Narrows a `Reason` to `Die`.

Source: `effect@4.0.2/src/Cause.ts:205`.

Vivid `Cause.isDieReason` matches: 3. apps/server/src/observability/export.test.ts:1488, apps/server/src/observability/failure.ts:505, apps/server/src/observability/guard.ts:361 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const isDieReason: <E>(self: Reason<E>) => self is Die;
```

## isInterruptReason

Narrows a `Reason` to `Interrupt`.

Source: `effect@4.0.2/src/Cause.ts:232`.

Vivid `Cause.isInterruptReason` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isInterruptReason: <E>(self: Reason<E>) => self is Interrupt;
```

## Die

An untyped defect . typically a programming error or an uncaught exception.

Source: `effect@4.0.2/src/Cause.ts:339`.

Vivid `Cause.Die` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export interface Die extends Cause.ReasonProto<"Die"> {
    readonly defect: unknown;
}
```

## Fail

A typed, expected error produced by `Effect.fail`.

Source: `effect@4.0.2/src/Cause.ts:375`.

Vivid `Cause.Fail` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export interface Fail<out E> extends Cause.ReasonProto<"Fail"> {
    readonly error: E;
}
```

## Interrupt

A fiber interruption signal, optionally carrying the ID of the fiber that initiated the interruption.

Source: `effect@4.0.2/src/Cause.ts:403`.

Vivid `Cause.Interrupt` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export interface Interrupt extends Cause.ReasonProto<"Interrupt"> {
    readonly fiberId: number | undefined;
}
```

## fromReasons

Creates a `Cause` from an array of `Reason` values.

Source: `effect@4.0.2/src/Cause.ts:444`.

Vivid `Cause.fromReasons` matches: 1. apps/server/src/observability/guard.ts:358 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const fromReasons: <E>(reasons: ReadonlyArray<Reason<E>>) => Cause<E>;
```

## empty

Represents a `Cause` with an empty `reasons` array.

Source: `effect@4.0.2/src/Cause.ts:475`.

Vivid `Cause.empty` matches: 0. No qualified match. Bare-name matches: 378. Aliased usage is unverified.

```ts
export declare const empty: Cause<never>;
```

## fail

Creates a `Cause` containing a single `Fail` reason with the given typed error.

Source: `effect@4.0.2/src/Cause.ts:500`.

Vivid `Cause.fail` matches: 4. apps/server/src/code/testing.ts:41, apps/server/src/computers/ssh/link.ts:548, apps/server/src/observability/export.test.ts:681 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: <E>(error: E) => Cause<E>;
```

## die

Creates a `Cause` containing a single `Die` reason with the given defect.

Source: `effect@4.0.2/src/Cause.ts:525`.

Vivid `Cause.die` matches: 3. apps/server/src/observability/export.test.ts:682, apps/server/src/observability/export.test.ts:1893, apps/server/src/threads/generation.test.ts:436 Bare-name matches: 95. Aliased usage is unverified.

```ts
export declare const die: (defect: unknown) => Cause<never>;
```

## interrupt

Creates a `Cause` containing a single `Interrupt` reason, optionally carrying the interrupting fiber's ID.

Source: `effect@4.0.2/src/Cause.ts:546`.

Vivid `Cause.interrupt` matches: 1. apps/server/src/observability/export.test.ts:682 Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const interrupt: (fiberId?: number | undefined) => Cause<never>;
```

## makeFailReason

Creates a standalone `Fail` reason (not wrapped in a `Cause`).

Source: `effect@4.0.2/src/Cause.ts:571`.

Vivid `Cause.makeFailReason` matches: 1. apps/server/src/observability/guard.ts:360 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const makeFailReason: <E>(error: E) => Fail<E>;
```

## makeDieReason

Creates a standalone `Die` reason (not wrapped in a `Cause`).

Source: `effect@4.0.2/src/Cause.ts:596`.

Vivid `Cause.makeDieReason` matches: 1. apps/server/src/observability/guard.ts:361 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const makeDieReason: (defect: unknown) => Die;
```

## makeInterruptReason

Creates a standalone `Interrupt` reason (not wrapped in a `Cause`), optionally carrying the interrupting fiber's ID.

Source: `effect@4.0.2/src/Cause.ts:622`.

Vivid `Cause.makeInterruptReason` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeInterruptReason: (fiberId?: number | undefined) => Interrupt;
```

## hasInterruptsOnly

Returns `true` if every reason in the cause is an `Interrupt` (and there is at least one reason).

Source: `effect@4.0.2/src/Cause.ts:648`.

Vivid `Cause.hasInterruptsOnly` matches: 5. apps/server/src/connections/migration.ts:284, apps/server/src/library/durability.test.ts:460, apps/server/src/library/extraction.test.ts:93 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const hasInterruptsOnly: <E>(self: Cause<E>) => boolean;
```

## map

Transforms the typed error values inside a `Cause` using the provided function. Only `Fail` reasons are affected; `Die` and `Interrupt` reasons pass through unchanged.

Source: `effect@4.0.2/src/Cause.ts:683`.

Vivid `Cause.map` matches: 0. No qualified match. Bare-name matches: 1501. Aliased usage is unverified.

```ts
export declare const map: {
    <E, E2>(f: (error: Types.NoInfer<E>) => E2): (self: Cause<E>) => Cause<E2>;
    <E, E2>(self: Cause<E>, f: (error: Types.NoInfer<E>) => E2): Cause<E2>;
};
```

## combine

Merges two causes into a single cause whose `reasons` array is the union of both inputs (de-duplicated by value equality).

Source: `effect@4.0.2/src/Cause.ts:784`.

Vivid `Cause.combine` matches: 2. apps/server/src/observability/export.test.ts:680, apps/server/src/observability/export.test.ts:682 Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const combine: {
    <E2>(that: Cause<E2>): <E>(self: Cause<E>) => Cause<E | E2>;
    <E, E2>(self: Cause<E>, that: Cause<E2>): Cause<E | E2>;
};
```

## squash

Collapses a `Cause` into a single `unknown` value, picking the "most important" failure in this order:

Source: `effect@4.0.2/src/Cause.ts:889`.

Vivid `Cause.squash` matches: 2. apps/server/src/observability/failure.ts:386, packages/agent/runtime/src/providers/witness.ts:332 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const squash: <E>(self: Cause<E>) => unknown;
```

## hasFails

Returns `true` if the cause contains at least one `Fail` reason.

Source: `effect@4.0.2/src/Cause.ts:915`.

Vivid `Cause.hasFails` matches: 2. apps/server/src/code/process.ts:175, apps/server/src/library/durability.test.ts:435 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const hasFails: <E>(self: Cause<E>) => boolean;
```

## findFail

Returns a `Result` whose success value is the first `Fail` reason in the cause, including its annotations. If the cause has no `Fail` reason, the failure value is the original cause narrowed to `Cause<never>`, because it contains no typed error reasons.

Source: `effect@4.0.2/src/Cause.ts:943`.

Vivid `Cause.findFail` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const findFail: <E>(self: Cause<E>) => Result.Result<Fail<E>, Cause<never>>;
```

## findError

Returns a `Result` whose success value is the first typed error value `E` from a `Fail` reason in the cause. If the cause has no `Fail` reason, the failure value is the original cause narrowed to `Cause<never>`, because it contains no typed error reasons.

Source: `effect@4.0.2/src/Cause.ts:971`.

Vivid `Cause.findError` matches: 1. apps/server/src/library/extraction.test.ts:53 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const findError: <E>(self: Cause<E>) => Result.Result<E, Cause<never>>;
```

## findErrorOption

Returns the first typed error value `E` from a cause wrapped in `Option.some`, or `Option.none` if no `Fail` reason exists.

Source: `effect@4.0.2/src/Cause.ts:997`.

Vivid `Cause.findErrorOption` matches: 10. apps/mobile/src/data/door.ts:56, apps/mobile/src/screen/door/attempt.ts:22, apps/server/src/computers/boat/bindings.ts:31 Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const findErrorOption: <E>(input: Cause<E>) => Option<E>;
```

## hasDies

Returns `true` if the cause contains at least one `Die` reason.

Source: `effect@4.0.2/src/Cause.ts:1023`.

Vivid `Cause.hasDies` matches: 4. apps/server/src/code/process.ts:176, apps/server/src/library/adoption.test.ts:129, apps/server/src/library/durability.test.ts:434 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const hasDies: <E>(self: Cause<E>) => boolean;
```

## findDie

Returns a `Result` whose success value is the first `Die` reason in the cause, including its annotations. If the cause has no `Die` reason, the failure value is the original cause.

Source: `effect@4.0.2/src/Cause.ts:1050`.

Vivid `Cause.findDie` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const findDie: <E>(self: Cause<E>) => Result.Result<Die, Cause<E>>;
```

## findDefect

Returns a `Result` whose success value is the first defect value from a `Die` reason in the cause. If the cause has no `Die` reason, the failure value is the original cause.

Source: `effect@4.0.2/src/Cause.ts:1077`.

Vivid `Cause.findDefect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const findDefect: <E>(self: Cause<E>) => Result.Result<unknown, Cause<E>>;
```

## hasInterrupts

Returns `true` if the cause contains at least one `Interrupt` reason.

Source: `effect@4.0.2/src/Cause.ts:1099`.

Vivid `Cause.hasInterrupts` matches: 5. apps/server/src/code/process.ts:177, apps/server/src/computers/store.test.ts:214, apps/server/src/library/adoption.test.ts:128 Bare-name matches: 8. Aliased usage is unverified.

```ts
export declare const hasInterrupts: <E>(self: Cause<E>) => boolean;
```

## findInterrupt

Returns a `Result` whose success value is the first `Interrupt` reason in the cause, including its annotations. If the cause has no `Interrupt` reason, the failure value is the original cause.

Source: `effect@4.0.2/src/Cause.ts:1125`.

Vivid `Cause.findInterrupt` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const findInterrupt: <E>(self: Cause<E>) => Result.Result<Interrupt, Cause<E>>;
```

## interruptors

Collects the defined fiber IDs from all `Interrupt` reasons in the cause into a `ReadonlySet`. Interrupt reasons without a `fiberId` are ignored. Returns an empty set when the cause has no interrupting fiber IDs.

Source: `effect@4.0.2/src/Cause.ts:1156`.

Vivid `Cause.interruptors` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interruptors: <E>(self: Cause<E>) => ReadonlySet<number>;
```

## filterInterruptors

Returns a `Result` whose success value is the set of defined fiber IDs from the cause's `Interrupt` reasons. If the cause has no `Interrupt` reason, the failure value is the original cause.

Source: `effect@4.0.2/src/Cause.ts:1188`.

Vivid `Cause.filterInterruptors` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterInterruptors: <E>(self: Cause<E>) => Result.Result<Set<number>, Cause<E>>;
```

## prettyErrors

Converts a `Cause` into an `Array<Error>` suitable for logging or rethrowing.

Source: `effect@4.0.2/src/Cause.ts:1233`.

Vivid `Cause.prettyErrors` matches: 1. apps/server/src/observability/guard.ts:332 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const prettyErrors: <E>(self: Cause<E>, options?: {
    readonly includeCauseInStack?: boolean | undefined;
}) => Array<Error>;
```

## pretty

Formats a `Cause` as a human-readable string for logging or debugging.

Source: `effect@4.0.2/src/Cause.ts:1281`.

Vivid `Cause.pretty` matches: 3. apps/server/src/code/process.ts:172, apps/server/src/observability/guard.ts:559, apps/server/src/threads/generation.ts:131 Bare-name matches: 41. Aliased usage is unverified.

```ts
export declare const pretty: <E>(cause: Cause<E>) => string;
```

## YieldableError

Base interface for error classes that can be yielded directly inside `Effect.gen`. Yielding one of these errors fails the generator with that error as the typed failure value.

Source: `effect@4.0.2/src/Cause.ts:1312`.

Vivid `Cause.YieldableError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface YieldableError extends Error, Pipeable, Inspectable {
    readonly [Effect.TypeId]: Effect.Variance<never, this, never>;
    [Symbol.iterator](): Effect.EffectIterator<Effect.Effect<never, this, never>>;
}
```

## isNoSuchElementError

Checks whether an arbitrary value is a `NoSuchElementError`.

Source: `effect@4.0.2/src/Cause.ts:1333`.

Vivid `Cause.isNoSuchElementError` matches: 1. packages/client/state/src/live.ts:64 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const isNoSuchElementError: (u: unknown) => u is NoSuchElementError;
```

## NoSuchElementErrorTypeId

Unique brand for `NoSuchElementError`.

Source: `effect@4.0.2/src/Cause.ts:1342`.

Vivid `Cause.NoSuchElementErrorTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const NoSuchElementErrorTypeId: "~effect/Cause/NoSuchElementError";
```

## NoSuchElementError

Constructs a `NoSuchElementError` with an optional message.

Source: `effect@4.0.2/src/Cause.ts:1394`.

Vivid `Cause.NoSuchElementError` matches: 3. apps/server/src/observability/failure.ts:304, packages/client/state/src/live.ts:57, packages/client/state/src/live.ts:61 Bare-name matches: 5. Aliased usage is unverified.

```ts
export interface NoSuchElementError extends YieldableError {
    readonly [NoSuchElementErrorTypeId]: typeof NoSuchElementErrorTypeId;
    readonly _tag: "NoSuchElementError";
}
export declare const NoSuchElementError: new (message?: string) => NoSuchElementError;
```

## isDone

Checks whether an arbitrary value is a `Done` signal.

Source: `effect@4.0.2/src/Cause.ts:1412`.

Vivid `Cause.isDone` matches: 0. No qualified match. Bare-name matches: 22. Aliased usage is unverified.

```ts
export declare const isDone: (u: unknown) => u is Done<any>;
```

## DoneTypeId

Unique brand for `Done` values.

Source: `effect@4.0.2/src/Cause.ts:1421`.

Vivid `Cause.DoneTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const DoneTypeId: "~effect/Cause/Done";
```

## Done

Creates a `Done` signal with an optional value.

Source: `effect@4.0.2/src/Cause.ts:1504`.

Vivid `Cause.Done` matches: 4. apps/server/src/code/testing.ts:22, apps/server/src/computers/egress/proxy.test.ts:101, apps/server/src/computers/egress/relay.ts:270 Bare-name matches: 151. Aliased usage is unverified.

```ts
export interface Done<A = void> {
    readonly [DoneTypeId]: typeof DoneTypeId;
    readonly _tag: "Done";
    readonly value: A;
}
export declare namespace Done {
    type Extract<E> = E extends Done<infer L> ? L : never;
    type Only<E> = E extends Done<infer L> ? Done<L> : never;
}
export declare const Done: <A = void>(value?: A) => Done<A>;
```

## done

Creates an Effect that fails with a `Done` error. Shorthand for `Effect.fail(Cause.Done(value))`.

Source: `effect@4.0.2/src/Cause.ts:1530`.

Vivid `Cause.done` matches: 0. No qualified match. Bare-name matches: 433. Aliased usage is unverified.

```ts
export declare const done: <A = void>(value?: A) => Effect.Effect<never, Done<A>>;
```

## TimeoutErrorTypeId

Unique brand for `TimeoutError`.

Source: `effect@4.0.2/src/Cause.ts:1539`.

Vivid `Cause.TimeoutErrorTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const TimeoutErrorTypeId: "~effect/Cause/TimeoutError";
```

## isTimeoutError

Checks whether an arbitrary value is a `TimeoutError`.

Source: `effect@4.0.2/src/Cause.ts:1557`.

Vivid `Cause.isTimeoutError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isTimeoutError: (u: unknown) => u is TimeoutError;
```

## TimeoutError

Constructs a `TimeoutError` with an optional message.

Source: `effect@4.0.2/src/Cause.ts:1591`.

Vivid `Cause.TimeoutError` matches: 1. apps/server/src/observability/failure.ts:303 Bare-name matches: 4. Aliased usage is unverified.

```ts
export interface TimeoutError extends YieldableError {
    readonly [TimeoutErrorTypeId]: typeof TimeoutErrorTypeId;
    readonly _tag: "TimeoutError";
}
export declare const TimeoutError: new (message?: string) => TimeoutError;
```

## IllegalArgumentErrorTypeId

Unique brand for `IllegalArgumentError`.

Source: `effect@4.0.2/src/Cause.ts:1600`.

Vivid `Cause.IllegalArgumentErrorTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const IllegalArgumentErrorTypeId: "~effect/Cause/IllegalArgumentError";
```

## isIllegalArgumentError

Checks whether an arbitrary value is an `IllegalArgumentError`.

Source: `effect@4.0.2/src/Cause.ts:1618`.

Vivid `Cause.isIllegalArgumentError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isIllegalArgumentError: (u: unknown) => u is IllegalArgumentError;
```

## IllegalArgumentError

Constructs an `IllegalArgumentError` with an optional message.

Source: `effect@4.0.2/src/Cause.ts:1652`.

Vivid `Cause.IllegalArgumentError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface IllegalArgumentError extends YieldableError {
    readonly [IllegalArgumentErrorTypeId]: typeof IllegalArgumentErrorTypeId;
    readonly _tag: "IllegalArgumentError";
}
export declare const IllegalArgumentError: new (message?: string) => IllegalArgumentError;
```

## isExceededCapacityError

Checks whether an arbitrary value is an `ExceededCapacityError`.

Source: `effect@4.0.2/src/Cause.ts:1670`.

Vivid `Cause.isExceededCapacityError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isExceededCapacityError: (u: unknown) => u is ExceededCapacityError;
```

## ExceededCapacityErrorTypeId

Unique brand for `ExceededCapacityError`.

Source: `effect@4.0.2/src/Cause.ts:1679`.

Vivid `Cause.ExceededCapacityErrorTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const ExceededCapacityErrorTypeId: "~effect/Cause/ExceededCapacityError";
```

## ExceededCapacityError

Constructs an `ExceededCapacityError` with an optional message.

Source: `effect@4.0.2/src/Cause.ts:1724`.

Vivid `Cause.ExceededCapacityError` matches: 1. packages/agent/runtime/src/notes.ts:273 Bare-name matches: 3. Aliased usage is unverified.

```ts
export interface ExceededCapacityError extends YieldableError {
    readonly [ExceededCapacityErrorTypeId]: typeof ExceededCapacityErrorTypeId;
    readonly _tag: "ExceededCapacityError";
}
export declare const ExceededCapacityError: new (message?: string) => ExceededCapacityError;
```

## AsyncFiberErrorTypeId

Unique brand present on `AsyncFiberError` values and used by `isAsyncFiberError` for runtime checks.

Source: `effect@4.0.2/src/Cause.ts:1734`.

Vivid `Cause.AsyncFiberErrorTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const AsyncFiberErrorTypeId: "~effect/Cause/AsyncFiberError";
```

## isAsyncFiberError

Checks whether an arbitrary value is an `AsyncFiberError`.

Source: `effect@4.0.2/src/Cause.ts:1755`.

Vivid `Cause.isAsyncFiberError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isAsyncFiberError: (u: unknown) => u is AsyncFiberError;
```

## AsyncFiberError

Constructs an `AsyncFiberError` for a fiber that could not be resolved synchronously.

Source: `effect@4.0.2/src/Cause.ts:1817`.

Vivid `Cause.AsyncFiberError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AsyncFiberError extends YieldableError {
    readonly [AsyncFiberErrorTypeId]: typeof AsyncFiberErrorTypeId;
    readonly _tag: "AsyncFiberError";
    readonly fiber: Fiber<unknown, unknown>;
}
export declare const AsyncFiberError: new (fiber: Fiber<unknown, unknown>) => AsyncFiberError;
```

## UnknownErrorTypeId

Unique brand for `UnknownError`.

Source: `effect@4.0.2/src/Cause.ts:1826`.

Vivid `Cause.UnknownErrorTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const UnknownErrorTypeId: "~effect/Cause/UnknownError";
```

## isUnknownError

Checks whether an arbitrary value is an `UnknownError`.

Source: `effect@4.0.2/src/Cause.ts:1844`.

Vivid `Cause.isUnknownError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isUnknownError: (u: unknown) => u is UnknownError;
```

## UnknownError

Constructs an `UnknownError`. The first argument is the original cause (stored in `Error.cause`); the second is an optional human-readable message.

Source: `effect@4.0.2/src/Cause.ts:1881`.

Vivid `Cause.UnknownError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface UnknownError extends YieldableError {
    readonly [UnknownErrorTypeId]: typeof UnknownErrorTypeId;
    readonly _tag: "UnknownError";
}
export declare const UnknownError: new (cause: unknown, message?: string) => UnknownError;
```

## annotate

Attaches metadata to every reason in a `Cause`.

Source: `effect@4.0.2/src/Cause.ts:1918`.

Vivid `Cause.annotate` matches: 0. No qualified match. Bare-name matches: 52. Aliased usage is unverified.

```ts
export declare const annotate: {
    (annotations: Context.Context<never>, options?: {
        readonly overwrite?: boolean | undefined;
    }): <E>(self: Cause<E>) => Cause<E>;
    <E>(self: Cause<E>, annotations: Context.Context<never>, options?: {
        readonly overwrite?: boolean | undefined;
    }): Cause<E>;
};
```

## reasonAnnotations

Reads the annotations from a single `Reason` as a `Context`.

Source: `effect@4.0.2/src/Cause.ts:2027`.

Vivid `Cause.reasonAnnotations` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const reasonAnnotations: <E>(self: Reason<E>) => Context.Context<never>;
```

## annotations

Reads the merged annotations from all reasons in a `Cause`.

Source: `effect@4.0.2/src/Cause.ts:2062`.

Vivid `Cause.annotations` matches: 0. No qualified match. Bare-name matches: 30. Aliased usage is unverified.

```ts
export declare const annotations: <E>(self: Cause<E>) => Context.Context<never>;
```

## StackTrace

Context annotation used to store the stack frame captured at the point of failure.

Source: `effect@4.0.2/src/Cause.ts:2086`.

Vivid `Cause.StackTrace` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class StackTrace extends StackTrace_base {
}
```

## InterruptorStackTrace

Context annotation used to store the stack frame captured at the point of interruption.

Source: `effect@4.0.2/src/Cause.ts:2109`.

Vivid `Cause.InterruptorStackTrace` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class InterruptorStackTrace extends InterruptorStackTrace_base {
}
```
