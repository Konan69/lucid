# AsyncResult

Import `effect/reactivity/AsyncResult`. Source `effect@4.0.2/src/reactivity/AsyncResult.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 42. Module-name matches in Vivid: 79. apps/mobile/src/App.tsx:2, apps/mobile/src/App.tsx:194, apps/mobile/src/data/appearance.ts:4

## TypeId

Runtime identifier attached to `AsyncResult` values and used by `isAsyncResult`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:49`.

Vivid `AsyncResult.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type TypeId = "~effect/reactivity/AsyncResult";
export declare const TypeId: TypeId;
```

## AsyncResult

Namespace containing type-level helpers and the shared prototype shape for `AsyncResult` values.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:75`.

Vivid `AsyncResult.AsyncResult` matches: 4. apps/mobile/src/data/door.ts:52, apps/mobile/src/data/held.ts:43, apps/web/src/screen/settings/General.tsx:128 Bare-name matches: 79. Aliased usage is unverified.

```ts
export type AsyncResult<A, E = never> = Initial<A, E> | Success<A, E> | Failure<A, E>;
export declare namespace AsyncResult {
    interface Proto<A, E> extends Pipeable {
        readonly [TypeId]: {
            readonly E: (_: never) => E;
            readonly A: (_: never) => A;
        };
        readonly waiting: boolean;
    }
    type Success<R> = R extends AsyncResult<infer A, infer _> ? A : never;
    type Failure<R> = R extends AsyncResult<infer _, infer E> ? E : never;
}
```

## isAsyncResult

Returns `true` when a value is an `AsyncResult`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:67`.

Vivid `AsyncResult.isAsyncResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isAsyncResult: (u: unknown) => u is AsyncResult<unknown, unknown>;
```

## With

Rebuilds an `AsyncResult` with new success and failure types while preserving the variant of another result.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:117`.

Vivid `AsyncResult.With` matches: 0. No qualified match. Bare-name matches: 82. Aliased usage is unverified.

```ts
export type With<R extends AsyncResult<any, any>, A, E> = R extends Initial<infer _A, infer _E> ? Initial<A, E> : R extends Success<infer _A, infer _E> ? Success<A, E> : R extends Failure<infer _A, infer _E> ? Failure<A, E> : never;
```

## isWaiting

Returns whether an `AsyncResult` is currently waiting for an asynchronous computation or refresh to finish.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:159`.

Vivid `AsyncResult.isWaiting` matches: 0. No qualified match. Bare-name matches: 14. Aliased usage is unverified.

```ts
export declare const isWaiting: <A, E>(result: AsyncResult<A, E>) => boolean;
```

## Initial

Initial `AsyncResult` state before a success value or failure cause is available.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:168`.

Vivid `AsyncResult.Initial` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export interface Initial<A, E = never> extends AsyncResult.Proto<A, E> {
    readonly _tag: "Initial";
}
```

## fromExit

Converts an `Exit` into a `Success` when it succeeds or a `Failure` carrying the exit cause when it fails.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:179`.

Vivid `AsyncResult.fromExit` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromExit: <A, E>(exit: Exit.Exit<A, E>) => Success<A, E> | Failure<A, E>;
```

## fromExitWithPrevious

Converts an `Exit` to a result, preserving the latest previous success when the exit is a failure.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:189`.

Vivid `AsyncResult.fromExitWithPrevious` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromExitWithPrevious: <A, E>(exit: Exit.Exit<A, E>, previous: Option.Option<AsyncResult<A, E>>) => Success<A, E> | Failure<A, E>;
```

## waitingFrom

Creates a waiting result from an optional previous result, using `Initial(true)` when no previous result exists.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:202`.

Vivid `AsyncResult.waitingFrom` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const waitingFrom: <A, E>(previous: Option.Option<AsyncResult<A, E>>) => AsyncResult<A, E>;
```

## isInitial

Returns `true` when an `AsyncResult` is in the `Initial` state.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:216`.

Vivid `AsyncResult.isInitial` matches: 3. apps/mobile/src/data/hearing.ts:58, apps/mobile/src/data/placed.ts:40, packages/client/state/src/live.ts:251 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const isInitial: <A, E>(result: AsyncResult<A, E>) => result is Initial<A, E>;
```

## isNotInitial

Returns `true` when an `AsyncResult` is either `Success` or `Failure`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:225`.

Vivid `AsyncResult.isNotInitial` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isNotInitial: <A, E>(result: AsyncResult<A, E>) => result is Success<A, E> | Failure<A, E>;
```

## initial

Creates an `Initial` result, optionally marking it as waiting.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:235`.

Vivid `AsyncResult.initial` matches: 1. apps/mobile/src/data/live.ts:497 Bare-name matches: 140. Aliased usage is unverified.

```ts
export declare const initial: <A = never, E = never>(waiting?: boolean) => Initial<A, E>;
```

## Success

Successful `AsyncResult` containing the current value, its timestamp, and the shared waiting flag.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:249`.

Vivid `AsyncResult.Success` matches: 0. No qualified match. Bare-name matches: 102. Aliased usage is unverified.

```ts
export interface Success<A, E = never> extends AsyncResult.Proto<A, E> {
    readonly _tag: "Success";
    readonly value: A;
    readonly timestamp: number;
}
```

## isSuccess

Returns `true` when an `AsyncResult` is a `Success`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:262`.

Vivid `AsyncResult.isSuccess` matches: 35. apps/mobile/src/App.tsx:194, apps/mobile/src/data/connecting.ts:181, apps/mobile/src/data/connecting.ts:284 Bare-name matches: 137. Aliased usage is unverified.

```ts
export declare const isSuccess: <A, E>(result: AsyncResult<A, E>) => result is Success<A, E>;
```

## success

Creates a `Success` result with a value and optional `waiting` flag or timestamp override.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:271`.

Vivid `AsyncResult.success` matches: 3. apps/mobile/src/data/held.ts:46, packages/client/state/src/live.ts:204, packages/client/state/src/live.ts:254 Bare-name matches: 374. Aliased usage is unverified.

```ts
export declare const success: <A, E = never>(value: A, options?: {
    readonly waiting?: boolean | undefined;
    readonly timestamp?: number | undefined;
}) => Success<A, E>;
```

## Failure

Failed `AsyncResult` containing a failure cause and the latest previous success when one is available.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:290`.

Vivid `AsyncResult.Failure` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export interface Failure<A, E = never> extends AsyncResult.Proto<A, E> {
    readonly _tag: "Failure";
    readonly cause: Cause.Cause<E>;
    readonly previousSuccess: Option.Option<Success<A, E>>;
}
```

## isFailure

Returns `true` when an `AsyncResult` is a `Failure`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:303`.

Vivid `AsyncResult.isFailure` matches: 3. apps/mobile/src/data/door.ts:55, apps/mobile/src/screen/door/attempt.ts:21, packages/client/state/src/live.ts:275 Bare-name matches: 197. Aliased usage is unverified.

```ts
export declare const isFailure: <A, E>(result: AsyncResult<A, E>) => result is Failure<A, E>;
```

## isInterrupted

Returns `true` when an `AsyncResult` is a `Failure` whose cause contains only interruptions.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:312`.

Vivid `AsyncResult.isInterrupted` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isInterrupted: <A, E>(result: AsyncResult<A, E>) => result is Failure<A, E>;
```

## failure

Creates a `Failure` result from a `Cause`, optionally preserving a previous success and marking the result as waiting.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:322`.

Vivid `AsyncResult.failure` matches: 0. No qualified match. Bare-name matches: 1320. Aliased usage is unverified.

```ts
export declare const failure: <A, E = never>(cause: Cause.Cause<E>, options?: {
    readonly previousSuccess?: Option.Option<Success<A, E>> | undefined;
    readonly waiting?: boolean | undefined;
}) => Failure<A, E>;
```

## failureWithPrevious

Creates a `Failure` result from a `Cause`, carrying forward the latest success stored in a previous result.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:344`.

Vivid `AsyncResult.failureWithPrevious` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const failureWithPrevious: <A, E>(cause: Cause.Cause<E>, options: {
    readonly previous: Option.Option<AsyncResult<A, E>>;
    readonly waiting?: boolean | undefined;
}) => Failure<A, E>;
```

## fail

Creates a `Failure` result from a typed error, wrapping it in `Cause.fail`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:368`.

Vivid `AsyncResult.fail` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: <E, A = never>(error: E, options?: {
    readonly previousSuccess?: Option.Option<Success<A, E>> | undefined;
    readonly waiting?: boolean | undefined;
}) => Failure<A, E>;
```

## failWithPrevious

Creates a `Failure` result from a typed error while carrying forward the latest success stored in a previous result.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:380`.

Vivid `AsyncResult.failWithPrevious` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const failWithPrevious: <A, E>(error: E, options: {
    readonly previous: Option.Option<AsyncResult<A, E>>;
    readonly waiting?: boolean | undefined;
}) => Failure<A, E>;
```

## waiting

Marks an `AsyncResult` as waiting, optionally touching the timestamp when the result is a `Success`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:395`.

Vivid `AsyncResult.waiting` matches: 0. No qualified match. Bare-name matches: 659. Aliased usage is unverified.

```ts
export declare const waiting: {
    (options?: {
        readonly touch?: boolean | undefined;
    }): <R extends AsyncResult<any, any>>(self: R) => R;
    <R extends AsyncResult<any, any>>(self: R, options?: {
        readonly touch?: boolean | undefined;
    }): R;
};
```

## touch

Refreshes the timestamp of a `Success` result while preserving its value and waiting flag; non-success results are returned unchanged.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:433`.

Vivid `AsyncResult.touch` matches: 0. No qualified match. Bare-name matches: 67. Aliased usage is unverified.

```ts
export declare const touch: <A extends AsyncResult<any, any>>(result: A) => A;
```

## replacePrevious

Replaces a `Failure` value's stored previous success with the latest success found in another result.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:448`.

Vivid `AsyncResult.replacePrevious` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const replacePrevious: {
    <XE, A>(previous: Option.Option<AsyncResult<A, XE>>): <R extends AsyncResult<any, any>>(self: R) => With<R, A, AsyncResult.Failure<R>>;
    <R extends AsyncResult<any, any>, XE, A>(self: R, previous: Option.Option<AsyncResult<A, XE>>): With<R, A, AsyncResult.Failure<R>>;
};
```

## value

Returns the current success value, or the previous success value stored in a failure, as an `Option`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:486`.

Vivid `AsyncResult.value` matches: 2. apps/mobile/src/data/hearing.ts:62, apps/mobile/src/data/placed.ts:45 Bare-name matches: 5731. Aliased usage is unverified.

```ts
export declare const value: <A, E>(self: AsyncResult<A, E>) => Option.Option<A>;
```

## getOrElse

Returns the available value from `value`, or evaluates the fallback when no current or previous success exists.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:502`.

Vivid `AsyncResult.getOrElse` matches: 2. apps/mobile/src/data/appearance.ts:89, apps/mobile/src/data/appearance.ts:125 Bare-name matches: 106. Aliased usage is unverified.

```ts
export declare const getOrElse: {
    <B>(orElse: LazyArg<B>): <A, E>(self: AsyncResult<A, E>) => A | B;
    <A, E, B>(self: AsyncResult<A, E>, orElse: LazyArg<B>): A | B;
};
```

## getOrThrow

Returns the available value from `value`, or throws `NoSuchElementError` when no current or previous success exists.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:528`.

Vivid `AsyncResult.getOrThrow` matches: 0. No qualified match. Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const getOrThrow: <A, E>(self: AsyncResult<A, E>) => A;
```

## cause

Returns the failure cause when the result is a `Failure`, otherwise `None`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:538`.

Vivid `AsyncResult.cause` matches: 0. No qualified match. Bare-name matches: 194. Aliased usage is unverified.

```ts
export declare const cause: <A, E>(self: AsyncResult<A, E>) => Option.Option<Cause.Cause<E>>;
```

## error

Returns the first typed error from a failure cause, or `None` for successes, initial results, defects, and interrupt-only causes.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:548`.

Vivid `AsyncResult.error` matches: 0. No qualified match. Bare-name matches: 1052. Aliased usage is unverified.

```ts
export declare const error: <A, E>(self: AsyncResult<A, E>) => Option.Option<E>;
```

## toExit

Converts a result to an `Exit`, succeeding with a success value, failing with a failure cause, or failing with `NoSuchElementError` for `Initial`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:558`.

Vivid `AsyncResult.toExit` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toExit: <A, E>(self: AsyncResult<A, E>) => Exit.Exit<A, E | Cause.NoSuchElementError>;
```

## map

Maps the success value of an `AsyncResult`, also mapping any previous success stored in a failure while leaving initial results unchanged.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:581`.

Vivid `AsyncResult.map` matches: 0. No qualified match. Bare-name matches: 1501. Aliased usage is unverified.

```ts
export declare const map: {
    <A, B>(f: (a: A) => B): <E>(self: AsyncResult<A, E>) => AsyncResult<B, E>;
    <E, A, B>(self: AsyncResult<A, E>, f: (a: A) => B): AsyncResult<B, E>;
};
```

## flatMap

Maps the success value of an `AsyncResult` and flattens the result.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:629`.

Vivid `AsyncResult.flatMap` matches: 0. No qualified match. Bare-name matches: 329. Aliased usage is unverified.

```ts
export declare const flatMap: {
    <A, E, B, E2>(f: (a: A, prev: Success<A, E>) => AsyncResult<B, E2>): (self: AsyncResult<A, E>) => AsyncResult<B, E | E2>;
    <E, A, B, E2>(self: AsyncResult<A, E>, f: (a: A, prev: Success<A, E>) => AsyncResult<B, E2>): AsyncResult<B, E | E2>;
};
```

## match

Pattern matches an `AsyncResult` by calling the handler for `Initial`, `Failure`, or `Success`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:733`.

Vivid `AsyncResult.match` matches: 2. apps/mobile/src/data/live.ts:448, packages/client/state/src/live.ts:76 Bare-name matches: 790. Aliased usage is unverified.

```ts
export declare const match: {
    <A, E, X, Y, Z>(options: {
        readonly onInitial: (_: Initial<A, E>) => X;
        readonly onFailure: (_: Failure<A, E>) => Y;
        readonly onSuccess: (_: Success<A, E>) => Z;
    }): (self: AsyncResult<A, E>) => X | Y | Z;
    <A, E, X, Y, Z>(self: AsyncResult<A, E>, options: {
        readonly onInitial: (_: Initial<A, E>) => X;
        readonly onFailure: (_: Failure<A, E>) => Y;
        readonly onSuccess: (_: Success<A, E>) => Z;
    }): X | Y | Z;
};
```

## matchWithError

Pattern matches a result, handling successes and initials directly while splitting failures into typed errors or squashed non-error causes passed to `onDefect`.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:785`.

Vivid `AsyncResult.matchWithError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const matchWithError: {
    <A, E, W, X, Y, Z>(options: {
        readonly onInitial: (_: Initial<A, E>) => W;
        readonly onError: (error: E, _: Failure<A, E>) => X;
        readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y;
        readonly onSuccess: (_: Success<A, E>) => Z;
    }): (self: AsyncResult<A, E>) => W | X | Y | Z;
    <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, options: {
        readonly onInitial: (_: Initial<A, E>) => W;
        readonly onError: (error: E, _: Failure<A, E>) => X;
        readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y;
        readonly onSuccess: (_: Success<A, E>) => Z;
    }): W | X | Y | Z;
};
```

## matchWithWaiting

Pattern matches a result by calling `onWaiting` for waiting or initial states, otherwise handling successes and splitting failures into typed errors or squashed non-error causes.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:845`.

Vivid `AsyncResult.matchWithWaiting` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const matchWithWaiting: {
    <A, E, W, X, Y, Z>(options: {
        readonly onWaiting: (_: AsyncResult<A, E>) => W;
        readonly onError: (error: E, _: Failure<A, E>) => X;
        readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y;
        readonly onSuccess: (_: Success<A, E>) => Z;
    }): (self: AsyncResult<A, E>) => W | X | Y | Z;
    <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, options: {
        readonly onWaiting: (_: AsyncResult<A, E>) => W;
        readonly onError: (error: E, _: Failure<A, E>) => X;
        readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y;
        readonly onSuccess: (_: Success<A, E>) => Z;
    }): W | X | Y | Z;
};
```

## all

Combines an iterable or record of `AsyncResult` and plain values into one `AsyncResult`, returning the first non-success result or a success of the collected values marked waiting when any input success is waiting.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:908`.

Vivid `AsyncResult.all` matches: 0. No qualified match. Bare-name matches: 560. Aliased usage is unverified.

```ts
export declare const all: <const Arg extends Iterable<any> | Record<string, any>>(results: Arg) => AsyncResult<[
    Arg
] extends [
    ReadonlyArray<any>
] ? {
    -readonly [K in keyof Arg]: [
        Arg[K]
    ] extends [
        AsyncResult<infer _A, infer _E>
    ] ? _A : Arg[K];
} : [
    Arg
] extends [
    Iterable<infer _A>
] ? _A extends AsyncResult<infer _AA, infer _E> ? _AA : _A : [
    Arg
] extends [
    Record<string, any>
] ? {
    -readonly [K in keyof Arg]: [
        Arg[K]
    ] extends [
        AsyncResult<infer _A, infer _E>
    ] ? _A : Arg[K];
} : never, [
    Arg
] extends [
    ReadonlyArray<any>
] ? AsyncResult.Failure<Arg[number]> : [
    Arg
] extends [
    Iterable<infer _A>
] ? AsyncResult.Failure<_A> : [
    Arg
] extends [
    Record<string, any>
] ? AsyncResult.Failure<Arg[keyof Arg]> : never>;
```

## builder

Creates a typed builder for rendering an `AsyncResult` by handling waiting, initial, success, error, defect, interrupt, and failure cases.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:953`.

Vivid `AsyncResult.builder` matches: 0. No qualified match. Bare-name matches: 23. Aliased usage is unverified.

```ts
export declare const builder: <A extends AsyncResult<any, any>>(self: A) => Builder<never, A extends Success<infer _A, infer _E> ? _A : never, A extends Failure<infer _A, infer _E> ? _E : never, A extends Initial<infer _A, infer _E> ? true : never, A extends Failure<infer _A, infer _E> ? Defect | Interrupt : never>;
```

## Defect

Type marker used by `Builder` to track whether defect failures still need to be handled.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:968`.

Vivid `AsyncResult.Defect` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export interface Defect {
    readonly _: unique symbol;
}
```

## Interrupt

Type marker used by `Builder` to track whether interrupt failures still need to be handled.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:979`.

Vivid `AsyncResult.Interrupt` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export interface Interrupt {
    readonly _: unique symbol;
}
```

## Builder

Fluent renderer for `AsyncResult` values that tracks unhandled cases at the type level and exposes `exhaustive` only after all possible cases are handled.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:990`.

Vivid `AsyncResult.Builder` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export type Builder<Out, A, E, I, F> = Pipeable & {
    onWaiting<B>(f: (result: AsyncResult<A, E>) => B): Builder<Out | B, A, E, I, F>;
    orElse<B>(orElse: LazyArg<B>): Out | B;
    orNull(): Out | null;
    render(): [
        A | I
    ] extends [
        never
    ] ? Out : Out | null;
} & ([
    A | E | I | F
] extends [
    never
] ? {
    exhaustive(): Out;
} : unknown) & ([
    I
] extends [
    never
] ? unknown : {
    onInitial<B>(f: (result: Initial<A, E>) => B): Builder<Out | B, A, E, never, F>;
    onInitialOrWaiting<B>(f: (result: AsyncResult<A, E>) => B): Builder<Out | B, A, E, never, F>;
}) & ([
    A
] extends [
    never
] ? unknown : {
    onSuccess<B>(f: (value: A, result: Success<A, E>) => B): Builder<Out | B, never, E, I, F>;
}) & ([
    E
] extends [
    never
] ? unknown : {
    onError<B>(f: (error: E, result: Failure<A, E>) => B): Builder<Out | B, A, never, I, F>;
    onErrorIf<B extends E, C>(refinement: Refinement<E, B>, f: (error: B, result: Failure<A, E>) => C): Builder<Out | C, A, Types.EqualsWith<E, B, E, Exclude<E, B>>, I, F>;
    onErrorIf<C>(predicate: Predicate<E>, f: (error: E, result: Failure<A, E>) => C): Builder<Out | C, A, E, I, F>;
    onErrorTag<const Tags extends ReadonlyArray<Types.Tags<E>>, B>(tags: Tags, f: (error: Types.ExtractTag<E, Tags[number]>, result: Failure<A, E>) => B): Builder<Out | B, A, Types.ExcludeTag<E, Tags[number]>, I, F>;
    onErrorTag<const Tag extends Types.Tags<E>, B>(tag: Tag, f: (error: Types.ExtractTag<E, Tag>, result: Failure<A, E>) => B): Builder<Out | B, A, Types.ExcludeTag<E, Tag>, I, F>;
}) & ([
    E | F
] extends [
    never
] ? unknown : {
    onFailure<B>(f: (cause: Cause.Cause<E>, result: Failure<A, E>) => B): Builder<Out | B, A, never, I, never>;
}) & (Interrupt extends F ? {
    onInterrupt<B>(f: (interruptors: ReadonlySet<number>, result: Failure<A, E>) => B): Builder<Out | B, A, E, I, Exclude<F, Interrupt>>;
} : unknown) & (Defect extends F ? {
    onDefect<B>(f: (defect: unknown, result: Failure<A, E>) => B): Builder<Out | B, A, E, I, Exclude<F, Defect>>;
} : unknown);
```

## Schema

Creates a schema for `AsyncResult` values using optional schemas for success values and failure errors.

Source: `effect@4.0.2/src/reactivity/AsyncResult.ts:1187`.

Vivid `AsyncResult.Schema` matches: 0. No qualified match. Bare-name matches: 5900. Aliased usage is unverified.

```ts
export interface Schema<Success extends Schema_.Constraint, Error extends Schema_.Constraint> extends Schema_.declareConstructor<AsyncResult<Success["Type"], Error["Type"]>, AsyncResult<Success["Encoded"], Error["Encoded"]>, readonly [
    Success,
    Schema_.Cause<Error, Schema_.Defect>
]> {
    readonly success: Success;
    readonly error: Error;
}
export declare const Schema: <A extends Schema_.Constraint = Schema_.Never, E extends Schema_.Constraint = Schema_.Never>(options: {
    readonly success?: A | undefined;
    readonly error?: E | undefined;
}) => Schema<A, E>;
```
