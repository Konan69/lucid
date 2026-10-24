# Effect

Import `effect/Effect`. Source `effect@4.0.2/src/Effect.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 88. Module-name matches in Vivid: 11603. apps/desktop/README.md:145, apps/desktop/scripts/build.mjs:14, apps/desktop/scripts/control.ts:7

## All

Namespace containing type utilities for the `Effect.all` function, which handles collecting multiple effects into various output structures.

Source: `effect@4.0.2/src/Effect.ts:274`.

Vivid `Effect.All` matches: 0. No qualified match. Bare-name matches: 61. Aliased usage is unverified.

```ts
export declare namespace All {
    type EffectAny = Effect<any, any, any>;
    type ReturnIterable<T extends Iterable<EffectAny>, Discard extends boolean, Mode extends boolean = false> = [
        T
    ] extends [
        Iterable<Effect<infer A, infer E, infer R>>
    ] ? Effect<Discard extends true ? void : Array<Mode extends true ? Result.Result<A, E> : A>, Mode extends true ? never : E, R> : never;
    type ReturnTuple<T extends ReadonlyArray<unknown>, Discard extends boolean, Mode extends boolean = false> = Effect<Discard extends true ? void : T[number] extends never ? [
    ] : {
        -readonly [K in keyof T]: T[K] extends Effect<infer _A, infer _E, infer _R> ? Mode extends true ? Result.Result<_A, _E> : _A : never;
    }, Mode extends true ? never : T[number] extends never ? never : T[number] extends Effect<infer _A, infer _E, infer _R> ? _E : never, T[number] extends never ? never : T[number] extends Effect<infer _A, infer _E, infer _R> ? _R : never> extends infer X ? X : never;
    type ReturnObject<T, Discard extends boolean, Mode extends boolean = false> = [
        T
    ] extends [
        Record<string, EffectAny>
    ] ? Effect<Discard extends true ? void : {
        -readonly [K in keyof T]: [
            T[K]
        ] extends [
            Effect<infer _A, infer _E, infer _R>
        ] ? Mode extends true ? Result.Result<_A, _E> : _A : never;
    }, Mode extends true ? never : Error<ObjectValues<T>>, Services<ObjectValues<T>>> : never;
    type IsDiscard<A> = [
        Extract<A, {
            readonly discard: true;
        }>
    ] extends [
        never
    ] ? false : true;
    type IsResult<A> = [
        Extract<A, {
            readonly mode: "result";
        }>
    ] extends [
        never
    ] ? false : true;
    type Return<Arg extends Iterable<EffectAny> | Record<string, EffectAny>, O extends {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: boolean | undefined;
        readonly mode?: "default" | "result" | undefined;
    }> = [
        Arg
    ] extends [
        ReadonlyArray<EffectAny>
    ] ? ReturnTuple<Arg, IsDiscard<O>, IsResult<O>> : [
        Arg
    ] extends [
        Iterable<EffectAny>
    ] ? ReturnIterable<Arg, IsDiscard<O>, IsResult<O>> : [
        Arg
    ] extends [
        Record<string, EffectAny>
    ] ? ReturnObject<Arg, IsDiscard<O>, IsResult<O>> : never;
    type ObjectValues<T> = T extends unknown ? T[keyof T] : never;
}
```

## all

Combines an iterable or record of effects into one effect whose success shape follows the input.

Source: `effect@4.0.2/src/Effect.ts:505`.

Vivid `Effect.all` matches: 36. apps/desktop/src/main/computer.test.ts:101, apps/desktop/src/main/driver.ts:47, apps/mobile/src/data/session.ts:255 Bare-name matches: 560. Aliased usage is unverified.

```ts
export declare const all: <const Arg extends Iterable<Effect<any, any, any>> | Record<string, Effect<any, any, any>>, O extends {
    readonly concurrency?: Concurrency | undefined;
    readonly discard?: boolean | undefined;
    readonly mode?: "default" | "result" | undefined;
}>(arg: Arg, options?: O) => All.Return<Arg, O>;
```

## partition

Applies an effectful function to each element and partitions successes and failures.

Source: `effect@4.0.2/src/Effect.ts:547`.

Vivid `Effect.partition` matches: 0. No qualified match. Bare-name matches: 367. Aliased usage is unverified.

```ts
export declare const partition: {
    <A, B, E, R>(f: (a: A, i: number) => Effect<B, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
    }): (elements: Iterable<A>) => Effect<[
        passes: Array<B>,
        fails: Array<E>
    ], never, R>;
    <A, B, E, R>(elements: Iterable<A>, f: (a: A, i: number) => Effect<B, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
    }): Effect<[
        passes: Array<B>,
        fails: Array<E>
    ], never, R>;
};
```

## reduce

Reduces elements from left to right with an effectful accumulator function.

Source: `effect@4.0.2/src/Effect.ts:653`.

Vivid `Effect.reduce` matches: 0. No qualified match. Bare-name matches: 48. Aliased usage is unverified.

```ts
export declare const reduce: {
    <Z, A, E, R>(zero: LazyArg<Z>, f: (z: Z, a: A, i: number) => Effect<Z, E, R>): (elements: Iterable<A>) => Effect<Z, E, R>;
    <A, Z, E, R>(elements: Iterable<A>, zero: LazyArg<Z>, f: (z: Z, a: A, i: number) => Effect<Z, E, R>): Effect<Z, E, R>;
};
```

## validate

Applies an effectful function to each element and accumulates all failures.

Source: `effect@4.0.2/src/Effect.ts:766`.

Vivid `Effect.validate` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const validate: {
    <A, B, E, R>(f: (a: A, i: number) => Effect<B, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: false | undefined;
    } | undefined): (elements: Iterable<A>) => Effect<Array<B>, Arr.NonEmptyArray<E>, R>;
    <A, B, E, R>(f: (a: A, i: number) => Effect<B, E, R>, options: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard: true;
    }): (elements: Iterable<A>) => Effect<void, Arr.NonEmptyArray<E>, R>;
    <A, B, E, R>(elements: Iterable<A>, f: (a: A, i: number) => Effect<B, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: false | undefined;
    } | undefined): Effect<Array<B>, Arr.NonEmptyArray<E>, R>;
    <A, B, E, R>(elements: Iterable<A>, f: (a: A, i: number) => Effect<B, E, R>, options: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard: true;
    }): Effect<void, Arr.NonEmptyArray<E>, R>;
};
```

## findFirst

Returns the first element that satisfies an effectful predicate.

Source: `effect@4.0.2/src/Effect.ts:933`.

Vivid `Effect.findFirst` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const findFirst: {
    <A, E, R>(predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>): (elements: Iterable<A>) => Effect<Option<A>, E, R>;
    <A, E, R>(elements: Iterable<A>, predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>): Effect<Option<A>, E, R>;
};
```

## findFirstFilter

Returns the first value that passes an effectful `FilterEffect`.

Source: `effect@4.0.2/src/Effect.ts:1004`.

Vivid `Effect.findFirstFilter` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const findFirstFilter: {
    <A, B, X, E, R>(filter: (input: NoInfer<A>, i: number) => Effect<Result.Result<B, X>, E, R>): (elements: Iterable<A>) => Effect<Option<B>, E, R>;
    <A, B, X, E, R>(elements: Iterable<A>, filter: (input: NoInfer<A>, i: number) => Effect<Result.Result<B, X>, E, R>): Effect<Option<B>, E, R>;
};
```

## forEach

Executes an effectful operation for each element in an `Iterable`.

Source: `effect@4.0.2/src/Effect.ts:1117`.

Vivid `Effect.forEach` matches: 167. apps/desktop/scripts/pages.ts:326, apps/desktop/src/main/control.ts:268, apps/desktop/src/main/cookies/read.ts:149 Bare-name matches: 174. Aliased usage is unverified.

```ts
export declare const forEach: {
    <A, B, E, R, S extends Iterable<A> = Iterable<A>, const Discard extends boolean = false>(f: (a: A, i: number) => Effect<B, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: Discard | undefined;
    } | undefined): (self: [
        S
    ] extends [
        never
    ] ? Iterable<A> : S) => Effect<Discard extends false ? Arr.ReadonlyArray.With<S, B> : void, E, R>;
    <B, E, R, S extends Iterable<any>, const Discard extends boolean = false>(self: S, f: (a: Arr.ReadonlyArray.Infer<S>, i: number) => Effect<B, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: Discard | undefined;
    } | undefined): Effect<Discard extends false ? Arr.ReadonlyArray.With<S, B> : void, E, R>;
};
```

## head

Returns the first element of the iterable produced by an effect, or fails with `NoSuchElementError` if the iterable is empty.

Source: `effect@4.0.2/src/Effect.ts:1286`.

Vivid `Effect.head` matches: 0. No qualified match. Bare-name matches: 141. Aliased usage is unverified.

```ts
export declare const head: <A, E, R>(self: Effect<Iterable<A>, E, R>) => Effect<A, E | Cause.NoSuchElementError, R>;
```

## whileLoop

Executes a body effect repeatedly while a condition holds true.

Source: `effect@4.0.2/src/Effect.ts:1315`.

Vivid `Effect.whileLoop` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const whileLoop: <A, E, R>(options: {
    readonly while: LazyArg<boolean>;
    readonly body: LazyArg<Effect<A, E, R>>;
    readonly step: (a: A) => void;
}) => Effect<void, E, R>;
```

## void

Returns an effect that succeeds with `void`.

Source: `effect@4.0.2/src/Effect.ts:1801`.

Vivid `Effect.void` matches: 277. apps/desktop/scripts/control.ts:166, apps/desktop/scripts/control.ts:239, apps/desktop/scripts/control.ts:452 Bare-name matches: 1605. Aliased usage is unverified.

```ts
declare const void_: Effect<void>;
export { void_ as void };
```

## undefined

Returns an effect that succeeds with `undefined`.

Source: `effect@4.0.2/src/Effect.ts:1813`.

Vivid `Effect.undefined` matches: 0. No qualified match. Bare-name matches: 1570. Aliased usage is unverified.

```ts
declare const undefined_: Effect<undefined>;
export { undefined_ as undefined };
```

## callback

Creates an `Effect` from a callback-based asynchronous API.

Source: `effect@4.0.2/src/Effect.ts:1853`.

Vivid `Effect.callback` matches: 83. apps/desktop/scripts/control.ts:53, apps/desktop/scripts/control.ts:451, apps/desktop/scripts/native.ts:76 Bare-name matches: 256. Aliased usage is unverified.

```ts
export declare const callback: <A, E = never, R = never>(register: (this: Scheduler, resume: (effect: Effect<A, E, R>) => void, signal: AbortSignal) => void | Effect<void, never, R>) => Effect<A, E, R>;
```

## never

Returns an effect that will never produce anything. The moral equivalent of `while(true) {}`, only without the wasted CPU cycles.

Source: `effect@4.0.2/src/Effect.ts:1878`.

Vivid `Effect.never` matches: 22. apps/server/src/approvals/review.test.ts:32, apps/server/src/approvals/review.test.ts:41, apps/server/src/artifacts/store.test.ts:48 Bare-name matches: 1556. Aliased usage is unverified.

```ts
export declare const never: Effect<never>;
```

## let

Adds a computed plain value to the do notation record.

Source: `effect@4.0.2/src/Effect.ts:1996`.

Vivid `Effect.let` matches: 0. No qualified match. Bare-name matches: 573. Aliased usage is unverified.

```ts
declare const let_: {
    <N extends string, A extends Record<string, any>, B>(name: N, f: (a: NoInfer<A>) => B): <E, R>(self: Effect<A, E, R>) => Effect<Simplify<Omit<A, N> & Record<N, B>>, E, R>;
    <A extends Record<string, any>, E, R, B, N extends string>(self: Effect<A, E, R>, name: N, f: (a: NoInfer<A>) => B): Effect<Simplify<Omit<A, N> & Record<N, B>>, E, R>;
};
export { let_ as let };
```

## try

Creates an `Effect` from a synchronous computation that may throw, mapping thrown values into the error channel.

Source: `effect@4.0.2/src/Effect.ts:2532`.

Vivid `Effect.try` matches: 56. apps/desktop/scripts/native.ts:37, apps/desktop/src/main/assets.ts:43, apps/desktop/src/main/assets.ts:75 Bare-name matches: 357. Aliased usage is unverified.

```ts
declare const try_: {
    <A>(options: LazyArg<A>): Effect<A, Cause.UnknownError>;
    <A, E>(options: {
        readonly try: LazyArg<A>;
        readonly catch: (error: unknown) => E;
    }): Effect<A, E>;
};
export { try_ as try };
```

## yieldNow

Yields control back to the Effect runtime, allowing other fibers to execute.

Source: `effect@4.0.2/src/Effect.ts:2558`.

Vivid `Effect.yieldNow` matches: 4. apps/mobile/src/data/live.ts:149, apps/mobile/src/data/live.ts:461, apps/server/src/connections/store.test.ts:498 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const yieldNow: Effect<void>;
```

## yieldNowWith

Yields control back to the Effect runtime with a specified priority, allowing other fibers to execute.

Source: `effect@4.0.2/src/Effect.ts:2583`.

Vivid `Effect.yieldNowWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const yieldNowWith: (priority?: number) => Effect<void>;
```

## exit

Transforms an effect to encapsulate both failure and success using the `Exit` data type.

Source: `effect@4.0.2/src/Effect.ts:3864`.

Vivid `Effect.exit` matches: 37. apps/desktop/src/main/installation.test.ts:62, apps/server/src/approvals/replay.test.ts:125, apps/server/src/approvals/replay.test.ts:161 Bare-name matches: 367. Aliased usage is unverified.

```ts
export declare const exit: <A, E, R>(self: Effect<A, E, R>) => Effect<Exit.Exit<A, E>, never, R>;
```

## zip

Combines two effects into a single effect, producing a tuple with the results of both effects.

Source: `effect@4.0.2/src/Effect.ts:4289`.

Vivid `Effect.zip` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const zip: {
    <A2, E2, R2>(that: Effect<A2, E2, R2>, options?: {
        readonly concurrent?: boolean | undefined;
    } | undefined): <A, E, R>(self: Effect<A, E, R>) => Effect<[
        A,
        A2
    ], E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, that: Effect<A2, E2, R2>, options?: {
        readonly concurrent?: boolean | undefined;
    }): Effect<[
        A,
        A2
    ], E | E2, R | R2>;
};
```

## zipWith

Combines two effects sequentially and applies a function to their results to produce a single value.

Source: `effect@4.0.2/src/Effect.ts:4457`.

Vivid `Effect.zipWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipWith: {
    <A2, E2, R2, A, B>(that: Effect<A2, E2, R2>, f: (a: A, b: A2) => B, options?: {
        readonly concurrent?: boolean | undefined;
    }): <E, R>(self: Effect<A, E, R>) => Effect<B, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2, B>(self: Effect<A, E, R>, that: Effect<A2, E2, R2>, f: (a: A, b: A2) => B, options?: {
        readonly concurrent?: boolean | undefined;
    }): Effect<B, E2 | E, R2 | R>;
};
```

## catch

Handles all errors in an effect by providing a fallback effect.

Source: `effect@4.0.2/src/Effect.ts:4588`.

Vivid `Effect.catch` matches: 111. apps/desktop/src/main/cookies/database.ts:94, apps/desktop/src/main/cookies/database.ts:108, apps/server/src/approvals/replay.ts:84 Bare-name matches: 320. Aliased usage is unverified.

```ts
declare const catch_: {
    <E, A2, E2, R2>(f: (e: E) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, f: (e: E) => Effect<A2, E2, R2>): Effect<A2 | A, E2, R2 | R>;
};
export { catch_ as catch };
```

## eventually

Retries an effect until it succeeds, discarding failures.

Source: `effect@4.0.2/src/Effect.ts:7417`.

Vivid `Effect.eventually` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const eventually: <A, E, R>(self: Effect<A, E, R>) => Effect<A, never, R>;
```

## Retry

Type helpers for retrying effects.

Source: `effect@4.0.2/src/Effect.ts:7430`.

Vivid `Effect.Retry` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare namespace Retry {
    type Return<R, E, A, O extends Options<E>> = Effect<A, (O extends {
        schedule: Schedule<infer _O, infer _I, infer _E1, infer _R>;
    } ? E : O extends {
        times: number;
    } ? E : O extends {
        until: Predicate.Refinement<E, infer E2>;
    } ? E2 : O extends {
        while: Predicate.Refinement<E, infer E2>;
    } ? Exclude<E, E2> : E) | (O extends {
        schedule: Schedule<infer _O, infer _I, infer E, infer _R>;
    } ? E : never) | (O extends {
        while: (...args: Array<any>) => Effect<infer _A, infer E, infer _R>;
    } ? E : never) | (O extends {
        until: (...args: Array<any>) => Effect<infer _A, infer E, infer _R>;
    } ? E : never), R | (O extends {
        schedule: Schedule<infer _O, infer _I, infer _E1, infer R>;
    } ? R : never) | (O extends {
        while: (...args: Array<any>) => Effect<infer _A, infer _E, infer R>;
    } ? R : never) | (O extends {
        until: (...args: Array<any>) => Effect<infer _A, infer _E, infer R>;
    } ? R : never)> extends infer Z ? Z : never;
    interface Options<E> {
        while?: ((error: E) => boolean | Effect<boolean, any, any>) | undefined;
        until?: ((error: E) => boolean | Effect<boolean, any, any>) | undefined;
        times?: number | undefined;
        schedule?: Schedule<any, E, any, any> | undefined;
    }
}
```

## retry

Retries typed failures from an effect according to a retry policy.

Source: `effect@4.0.2/src/Effect.ts:7526`.

Vivid `Effect.retry` matches: 12. apps/desktop/src/main/device.ts:332, apps/desktop/src/main/egress.ts:779, apps/mobile/src/data/session.ts:208 Bare-name matches: 148. Aliased usage is unverified.

```ts
export declare const retry: {
    <E, O extends Retry.Options<E>>(options: O): <A, R>(self: Effect<A, E, R>) => Retry.Return<R, E, A, O>;
    <B, E, Error, Env>(policy: Schedule<B, NoInfer<E>, Error, Env>): <A, R>(self: Effect<A, E, R>) => Effect<A, E | Error, R | Env>;
    <B, E, Error, Env>(builder: ($: <O, SE, R>(_: Schedule<O, NoInfer<E>, SE, R>) => Schedule<O, E, SE, R>) => Schedule<B, NoInfer<E>, Error, Env>): <A, R>(self: Effect<A, E, R>) => Effect<A, E | Error, R | Env>;
    <A, E, R, O extends Retry.Options<E>>(self: Effect<A, E, R>, options: O): Retry.Return<R, E, A, O>;
    <A, E, R, B, Error, Env>(self: Effect<A, E, R>, policy: Schedule<B, NoInfer<E>, Error, Env>): Effect<A, E | Error, R | Env>;
    <A, E, R, B, Error, Env>(self: Effect<A, E, R>, builder: ($: <O, SE, R>(_: Schedule<O, NoInfer<E>, SE, R>) => Schedule<O, E, SE, R>) => Schedule<B, NoInfer<E>, Error, Env>): Effect<A, E | Error, R | Env>;
};
```

## retryOrElse

Retries a failing effect and runs a fallback effect if retries are exhausted.

Source: `effect@4.0.2/src/Effect.ts:7910`.

Vivid `Effect.retryOrElse` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const retryOrElse: {
    <A1, E, E1, R1, A2, E2, R2>(policy: Schedule<A1, NoInfer<E>, E1, R1>, orElse: (e: NoInfer<E>, out: A1) => Effect<A2, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A | A2, E1 | E2, R | R1 | R2>;
    <A, E, R, A1, E1, R1, A2, E2, R2>(self: Effect<A, E, R>, policy: Schedule<A1, NoInfer<E>, E1, R1>, orElse: (e: NoInfer<E>, out: A1) => Effect<A2, E2, R2>): Effect<A | A2, E1 | E2, R | R1 | R2>;
};
```

## timeout

Adds a time limit to an effect, triggering a timeout if the effect exceeds the duration.

Source: `effect@4.0.2/src/Effect.ts:8651`.

Vivid `Effect.timeout` matches: 16. apps/mobile/src/data/session.ts:259, apps/server/src/approvals/request.ts:141, apps/server/src/channels/photon.ts:139 Bare-name matches: 185. Aliased usage is unverified.

```ts
export declare const timeout: {
    (duration: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | Cause.TimeoutError, R>;
    <A, E, R>(self: Effect<A, E, R>, duration: Duration.Input): Effect<A, E | Cause.TimeoutError, R>;
};
```

## timeoutOption

Runs an effect with a time limit and represents only the timeout case as `Option.none`.

Source: `effect@4.0.2/src/Effect.ts:8771`.

Vivid `Effect.timeoutOption` matches: 13. apps/desktop/src/main/chromium.ts:191, apps/desktop/src/main/computer.ts:419, apps/desktop/src/main/control.ts:835 Bare-name matches: 14. Aliased usage is unverified.

```ts
export declare const timeoutOption: {
    (duration: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<Option<A>, E, R>;
    <A, E, R>(self: Effect<A, E, R>, duration: Duration.Input): Effect<Option<A>, E, R>;
};
```

## timeoutOrElse

Applies a timeout to an effect, lazily evaluating `orElse` after interrupting the source if the timeout is reached.

Source: `effect@4.0.2/src/Effect.ts:8866`.

Vivid `Effect.timeoutOrElse` matches: 29. apps/desktop/src/main/server.ts:43, apps/mobile/src/data/google.ts:253, apps/server/src/channels/replies.ts:52 Bare-name matches: 30. Aliased usage is unverified.

```ts
export declare const timeoutOrElse: {
    <A2, E2, R2>(options: {
        readonly duration: Duration.Input;
        readonly orElse: LazyArg<Effect<A2, E2, R2>>;
    }): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
    <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, options: {
        readonly duration: Duration.Input;
        readonly orElse: LazyArg<Effect<A2, E2, R2>>;
    }): Effect<A | A2, E | E2, R | R2>;
};
```

## delay

Returns an effect that is delayed from this effect by the specified `Duration`.

Source: `effect@4.0.2/src/Effect.ts:8958`.

Vivid `Effect.delay` matches: 0. No qualified match. Bare-name matches: 117. Aliased usage is unverified.

```ts
export declare const delay: {
    (duration: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
    <A, E, R>(self: Effect<A, E, R>, duration: Duration.Input): Effect<A, E, R>;
};
```

## sleep

Returns an effect that suspends the current fiber for the specified duration without blocking a JavaScript thread.

Source: `effect@4.0.2/src/Effect.ts:9027`.

Vivid `Effect.sleep` matches: 28. apps/desktop/src/main/control.ts:692, apps/desktop/src/main/egress.ts:673, apps/desktop/src/main/egress.ts:687 Bare-name matches: 52. Aliased usage is unverified.

```ts
export declare const sleep: (duration: Duration.Input) => Effect<void>;
```

## timed

Returns the runtime duration of an effect together with its result.

Source: `effect@4.0.2/src/Effect.ts:9054`.

Vivid `Effect.timed` matches: 3. apps/server/src/code/computer.live.test.ts:61, apps/server/src/computers/boat.live.test.ts:29, apps/server/src/computers/ssh/computer.live.test.ts:130 Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const timed: <A, E, R>(self: Effect<A, E, R>) => Effect<[
    duration: Duration.Duration,
    result: A
], E, R>;
```

## raceAll

Runs multiple effects concurrently and returns the first successful result.

Source: `effect@4.0.2/src/Effect.ts:9093`.

Vivid `Effect.raceAll` matches: 1. apps/server/src/runtime/settlement.ts:183 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const raceAll: <Eff extends Effect<any, any, any>>(all: Iterable<Eff>, options?: {
    readonly onWinner?: (options: {
        readonly fiber: Fiber<any, any>;
        readonly index: number;
        readonly parentFiber: Fiber<any, any>;
    }) => void;
}) => Effect<Success<Eff>, Error<Eff>, Services<Eff>>;
```

## raceAllFirst

Runs multiple effects concurrently and completes with the first effect to finish, whether it succeeds or fails.

Source: `effect@4.0.2/src/Effect.ts:9130`.

Vivid `Effect.raceAllFirst` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const raceAllFirst: <Eff extends Effect<any, any, any>>(all: Iterable<Eff>, options?: {
    readonly onWinner?: (options: {
        readonly fiber: Fiber<any, any>;
        readonly index: number;
        readonly parentFiber: Fiber<any, any>;
    }) => void;
}) => Effect<Success<Eff>, Error<Eff>, Services<Eff>>;
```

## race

Races two effects and returns the first successful result.

Source: `effect@4.0.2/src/Effect.ts:9171`.

Vivid `Effect.race` matches: 0. No qualified match. Bare-name matches: 32. Aliased usage is unverified.

```ts
export declare const race: {
    <A2, E2, R2>(that: Effect<A2, E2, R2>, options?: {
        readonly onWinner?: (options: {
            readonly fiber: Fiber<any, any>;
            readonly index: number;
            readonly parentFiber: Fiber<any, any>;
        }) => void;
    }): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
    <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, that: Effect<A2, E2, R2>, options?: {
        readonly onWinner?: (options: {
            readonly fiber: Fiber<any, any>;
            readonly index: number;
            readonly parentFiber: Fiber<any, any>;
        }) => void;
    }): Effect<A | A2, E | E2, R | R2>;
};
```

## raceFirst

Races two effects and returns the result of the first one to complete, whether it succeeds or fails.

Source: `effect@4.0.2/src/Effect.ts:9289`.

Vivid `Effect.raceFirst` matches: 44. apps/desktop/src/main/control.ts:774, apps/desktop/src/main/device.ts:341, apps/desktop/src/main/egress.test.ts:647 Bare-name matches: 44. Aliased usage is unverified.

```ts
export declare const raceFirst: {
    <A2, E2, R2>(that: Effect<A2, E2, R2>, options?: {
        readonly onWinner?: (options: {
            readonly fiber: Fiber<any, any>;
            readonly index: number;
            readonly parentFiber: Fiber<any, any>;
        }) => void;
    }): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>;
    <A, E, R, A2, E2, R2>(self: Effect<A, E, R>, that: Effect<A2, E2, R2>, options?: {
        readonly onWinner?: (options: {
            readonly fiber: Fiber<any, any>;
            readonly index: number;
            readonly parentFiber: Fiber<any, any>;
        }) => void;
    }): Effect<A | A2, E | E2, R | R2>;
};
```

## filter

Filters elements of an iterable using a predicate, refinement, or effectful predicate.

Source: `effect@4.0.2/src/Effect.ts:9414`.

Vivid `Effect.filter` matches: 1. apps/server/src/rules/judge.ts:118 Bare-name matches: 621. Aliased usage is unverified.

```ts
export declare const filter: {
    <A, B extends A>(refinement: Predicate.Refinement<NoInfer<A>, B>): (elements: Iterable<A>) => Effect<Array<B>>;
    <A>(predicate: Predicate.Predicate<NoInfer<A>>): (elements: Iterable<A>) => Effect<Array<A>>;
    <A, E, R>(predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
    }): (iterable: Iterable<A>) => Effect<Array<A>, E, R>;
    <A, B extends A>(elements: Iterable<A>, refinement: Predicate.Refinement<A, B>): Effect<Array<B>>;
    <A>(elements: Iterable<A>, predicate: Predicate.Predicate<A>): Effect<Array<A>>;
    <A, E, R>(iterable: Iterable<A>, predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
    }): Effect<Array<A>, E, R>;
};
```

## filterMap

Filters and maps elements of an iterable with a `Filter`.

Source: `effect@4.0.2/src/Effect.ts:9624`.

Vivid `Effect.filterMap` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const filterMap: {
    <A, B, X>(filter: Filter.Filter<NoInfer<A>, B, X>): (elements: Iterable<A>) => Effect<Array<B>>;
    <A, B, X>(elements: Iterable<A>, filter: Filter.Filter<NoInfer<A>, B, X>): Effect<Array<B>>;
};
```

## filterMapEffect

Filters and maps elements of an iterable effectfully with a `FilterEffect`.

Source: `effect@4.0.2/src/Effect.ts:9694`.

Vivid `Effect.filterMapEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterMapEffect: {
    <A, B, X, E, R>(filter: Filter.FilterEffect<NoInfer<A>, B, X, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
    }): (elements: Iterable<A>) => Effect<Array<B>, E, R>;
    <A, B, X, E, R>(elements: Iterable<A>, filter: Filter.FilterEffect<NoInfer<A>, B, X, E, R>, options?: {
        readonly concurrency?: Concurrency | undefined;
    }): Effect<Array<B>, E, R>;
};
```

## scope

Returns the current scope for resource management.

Source: `effect@4.0.2/src/Effect.ts:13210`.

Vivid `Effect.scope` matches: 11. apps/desktop/src/main/signin.ts:406, apps/desktop/src/main/turn.ts:420, apps/server/src/computers/store.ts:677 Bare-name matches: 837. Aliased usage is unverified.

```ts
export declare const scope: Effect<Scope, never, Scope>;
```

## scoped

Runs an effect with a scope that closes when the effect completes.

Source: `effect@4.0.2/src/Effect.ts:13251`.

Vivid `Effect.scoped` matches: 701. apps/desktop/scripts/control.ts:447, apps/desktop/scripts/pages.ts:274, apps/desktop/src/main/cookies/database.ts:73 Bare-name matches: 855. Aliased usage is unverified.

```ts
export declare const scoped: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, Scope>>;
```

## scopedWith

Creates a scoped effect by providing access to the scope.

Source: `effect@4.0.2/src/Effect.ts:13296`.

Vivid `Effect.scopedWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const scopedWith: <A, E, R>(f: (scope: Scope) => Effect<A, E, R>) => Effect<A, E, R>;
```

## acquireRelease

Constructs a scoped resource from an acquisition effect and a release finalizer.

Source: `effect@4.0.2/src/Effect.ts:13366`.

Vivid `Effect.acquireRelease` matches: 119. apps/desktop/scripts/control.ts:52, apps/desktop/scripts/native.ts:104, apps/desktop/scripts/native.ts:136 Bare-name matches: 123. Aliased usage is unverified.

```ts
export declare const acquireRelease: <A, E, R, R2>(acquire: Effect<A, E, R>, release: (a: A, exit: Exit.Exit<unknown, unknown>) => Effect<unknown, never, R2>, options?: {
    readonly interruptible?: boolean;
}) => Effect<A, E, R | R2 | Scope>;
```

## acquireDisposable

Acquires a scoped resource that implements JavaScript disposal protocols.

Source: `effect@4.0.2/src/Effect.ts:13421`.

Vivid `Effect.acquireDisposable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const acquireDisposable: <A extends AsyncDisposable | Disposable, E, R>(acquire: Effect<A, E, R>) => Effect<A, E, R | Scope>;
```

## acquireUseRelease

Runs resource acquisition, usage, and release as one bracketed effect.

Source: `effect@4.0.2/src/Effect.ts:13500`.

Vivid `Effect.acquireUseRelease` matches: 10. apps/desktop/src/main/settings.ts:141, apps/server/src/connections/executor.live.test.ts:56, apps/server/src/connections/google.live.test.ts:61 Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const acquireUseRelease: <Resource, E, R, A, E2, R2, E3, R3>(acquire: Effect<Resource, E, R>, use: (a: Resource) => Effect<A, E2, R2>, release: (a: Resource, exit: Exit.Exit<A, E2>) => Effect<void, E3, R3>) => Effect<A, E | E2 | E3, R | R2 | R3>;
```

## addFinalizer

Adds a finalizer to the current scope.

Source: `effect@4.0.2/src/Effect.ts:13553`.

Vivid `Effect.addFinalizer` matches: 123. apps/desktop/scripts/control.ts:371, apps/desktop/src/main/egress.ts:720, apps/desktop/src/main/signin.ts:505 Bare-name matches: 129. Aliased usage is unverified.

```ts
export declare const addFinalizer: <R>(finalizer: (exit: Exit.Exit<unknown, unknown>) => Effect<void, never, R>) => Effect<void, never, R | Scope>;
```

## ensuring

Returns an effect that, if this effect _starts_ execution, then the specified `finalizer` is guaranteed to be executed, whether this effect succeeds, fails, or is interrupted.

Source: `effect@4.0.2/src/Effect.ts:13596`.

Vivid `Effect.ensuring` matches: 35. apps/desktop/src/main/browser.ts:713, apps/desktop/src/main/computer.ts:421, apps/desktop/src/main/control.ts:333 Bare-name matches: 39. Aliased usage is unverified.

```ts
export declare const ensuring: {
    <X, R1>(finalizer: Effect<X, never, R1>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R1 | R>;
    <A, E, R, X, R1>(self: Effect<A, E, R>, finalizer: Effect<X, never, R1>): Effect<A, E, R1 | R>;
};
```

## onError

Runs the specified effect if this effect fails, providing the error to the effect if it exists. The provided effect will not be interrupted.

Source: `effect@4.0.2/src/Effect.ts:13707`.

Vivid `Effect.onError` matches: 7. apps/desktop/src/main/driver.ts:55, apps/desktop/src/main/turn.ts:276, apps/server/src/computers/handlers.ts:84 Bare-name matches: 26. Aliased usage is unverified.

```ts
export declare const onError: {
    <E, X, R2>(cleanup: (cause: Cause.Cause<E>) => Effect<X, never, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R2 | R>;
    <A, E, R, X, R2>(self: Effect<A, E, R>, cleanup: (cause: Cause.Cause<E>) => Effect<X, never, R2>): Effect<A, E, R2 | R>;
};
```

## onErrorIf

Runs the finalizer only when this effect fails and the `Cause` matches the provided predicate.

Source: `effect@4.0.2/src/Effect.ts:13800`.

Vivid `Effect.onErrorIf` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const onErrorIf: {
    <E, XE, XR>(predicate: Predicate.Predicate<Cause.Cause<E>>, f: (cause: Cause.Cause<E>) => Effect<void, XE, XR>): <A, R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>;
    <A, E, R, XE, XR>(self: Effect<A, E, R>, predicate: Predicate.Predicate<Cause.Cause<E>>, f: (cause: Cause.Cause<E>) => Effect<void, XE, XR>): Effect<A, E | XE, R | XR>;
};
```

## onErrorFilter

Runs the finalizer only when this effect fails and the cause matches the provided `Filter`.

Source: `effect@4.0.2/src/Effect.ts:13887`.

Vivid `Effect.onErrorFilter` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const onErrorFilter: {
    <A, E, EB, X, XE, XR>(filter: Filter.Filter<Cause.Cause<E>, EB, X>, f: (failure: EB, cause: Cause.Cause<E>) => Effect<void, XE, XR>): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>;
    <A, E, R, EB, X, XE, XR>(self: Effect<A, E, R>, filter: Filter.Filter<Cause.Cause<E>, EB, X>, f: (failure: EB, cause: Cause.Cause<E>) => Effect<void, XE, XR>): Effect<A, E | XE, R | XR>;
};
```

## onExitPrimitive

Runs an optional finalizer with the effect's `Exit` value when the effect completes.

Source: `effect@4.0.2/src/Effect.ts:13955`.

Vivid `Effect.onExitPrimitive` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const onExitPrimitive: <A, E, R, XE = never, XR = never>(self: Effect<A, E, R>, f: (exit: Exit.Exit<A, E>) => Effect<void, XE, XR> | undefined, interruptible?: boolean) => Effect<A, E | XE, R | XR>;
```

## onExit

Ensures that a cleanup function runs whether this effect succeeds, fails, or is interrupted.

Source: `effect@4.0.2/src/Effect.ts:13992`.

Vivid `Effect.onExit` matches: 8. apps/server/src/code/process.ts:244, apps/server/src/computers/egress/relay.test.ts:633, apps/server/src/computers/egress/relay.test.ts:718 Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const onExit: {
    <A, E, XE = never, XR = never>(f: (exit: Exit.Exit<A, E>) => Effect<void, XE, XR>): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>;
    <A, E, R, XE = never, XR = never>(self: Effect<A, E, R>, f: (exit: Exit.Exit<A, E>) => Effect<void, XE, XR>): Effect<A, E | XE, R | XR>;
};
```

## onExitIf

Runs the cleanup effect only when the `Exit` satisfies the provided predicate.

Source: `effect@4.0.2/src/Effect.ts:14086`.

Vivid `Effect.onExitIf` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const onExitIf: {
    <A, E, XE, XR>(predicate: Predicate.Predicate<Exit.Exit<NoInfer<A>, NoInfer<E>>>, f: (exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>;
    <A, E, R, XE, XR>(self: Effect<A, E, R>, predicate: Predicate.Predicate<Exit.Exit<NoInfer<A>, NoInfer<E>>>, f: (exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>): Effect<A, E | XE, R | XR>;
};
```

## onExitFilter

Runs the cleanup effect only when the `Exit` matches the provided `Filter`.

Source: `effect@4.0.2/src/Effect.ts:14174`.

Vivid `Effect.onExitFilter` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const onExitFilter: {
    <A, E, XE, XR, B, X>(filter: Filter.Filter<Exit.Exit<NoInfer<A>, NoInfer<E>>, B, X>, f: (b: B, exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>;
    <A, E, R, XE, XR, B, X>(self: Effect<A, E, R>, filter: Filter.Filter<Exit.Exit<NoInfer<A>, NoInfer<E>>, B, X>, f: (b: B, exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>): Effect<A, E | XE, R | XR>;
};
```

## cached

Returns an effect that lazily computes a result and caches it for subsequent evaluations.

Source: `effect@4.0.2/src/Effect.ts:14290`.

Vivid `Effect.cached` matches: 1. apps/server/src/connections/store.ts:578 Bare-name matches: 33. Aliased usage is unverified.

```ts
export declare const cached: <A, E, R>(self: Effect<A, E, R>) => Effect<Effect<A, E, R>>;
```

## cachedWithTTL

Returns an effect that caches its result for a fixed duration or a duration computed from its `Exit`, known as "timeToLive" (TTL).

Source: `effect@4.0.2/src/Effect.ts:14377`.

Vivid `Effect.cachedWithTTL` matches: 3. apps/server/src/connections/store.ts:521, apps/server/src/memory/helix.ts:1264, apps/server/src/memory/helix.ts:1288 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const cachedWithTTL: {
    <A, E>(timeToLive: (exit: Exit.Exit<A, E>) => Duration.Input): <R>(self: Effect<A, E, R>) => Effect<Effect<A, E, R>>;
    (timeToLive: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<Effect<A, E, R>>;
    <A, E>(timeToLive: Duration.Input | ((exit: Exit.Exit<A, E>) => Duration.Input)): <R>(self: Effect<A, E, R>) => Effect<Effect<A, E, R>>;
    <A, E, R>(self: Effect<A, E, R>, timeToLive: Duration.Input | ((exit: Exit.Exit<A, E>) => Duration.Input)): Effect<Effect<A, E, R>>;
};
```

## cachedInvalidateWithTTL

Creates a cached effect result for a fixed duration or a duration computed from its `Exit` and allows manual invalidation before expiration.

Source: `effect@4.0.2/src/Effect.ts:14786`.

Vivid `Effect.cachedInvalidateWithTTL` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const cachedInvalidateWithTTL: {
    <A, E>(timeToLive: (exit: Exit.Exit<A, E>) => Duration.Input): <R>(self: Effect<A, E, R>) => Effect<[
        Effect<A, E, R>,
        Effect<void>
    ]>;
    (timeToLive: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<[
        Effect<A, E, R>,
        Effect<void>
    ]>;
    <A, E>(timeToLive: Duration.Input | ((exit: Exit.Exit<A, E>) => Duration.Input)): <R>(self: Effect<A, E, R>) => Effect<[
        Effect<A, E, R>,
        Effect<void>
    ]>;
    <A, E, R>(self: Effect<A, E, R>, timeToLive: Duration.Input | ((exit: Exit.Exit<A, E>) => Duration.Input)): Effect<[
        Effect<A, E, R>,
        Effect<void>
    ]>;
};
```

## interrupt

Returns an effect that is immediately interrupted.

Source: `effect@4.0.2/src/Effect.ts:15056`.

Vivid `Effect.interrupt` matches: 3. apps/server/src/code/process.test.ts:875, apps/server/src/observability/export.test.ts:524, apps/server/src/observability/export.ts:615 Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const interrupt: Effect<never>;
```

## interruptible

Returns a new effect that allows the effect to be interruptible.

Source: `effect@4.0.2/src/Effect.ts:15076`.

Vivid `Effect.interruptible` matches: 8. apps/server/src/approvals/replay.ts:80, apps/server/src/approvals/replay.ts:135, apps/server/src/artifacts/store.ts:227 Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const interruptible: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
```

## onInterrupt

Runs the specified finalizer effect if this effect is interrupted.

Source: `effect@4.0.2/src/Effect.ts:15105`.

Vivid `Effect.onInterrupt` matches: 8. apps/server/src/code/calls.test.ts:188, apps/server/src/computers/device.ts:736, apps/server/src/computers/ssh/link.ts:493 Bare-name matches: 8. Aliased usage is unverified.

```ts
export declare const onInterrupt: {
    <XE, XR>(finalizer: (interruptors: ReadonlySet<number>) => Effect<void, XE, XR>): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>;
    <A, E, R, XE, XR>(self: Effect<A, E, R>, finalizer: (interruptors: ReadonlySet<number>) => Effect<void, XE, XR>): Effect<A, E | XE, R | XR>;
};
```

## uninterruptible

Returns a new effect that disables interruption for the given effect.

Source: `effect@4.0.2/src/Effect.ts:15187`.

Vivid `Effect.uninterruptible` matches: 17. apps/desktop/src/main/settings.ts:193, apps/mobile/src/data/session.ts:164, apps/server/src/approvals/store.ts:492 Bare-name matches: 24. Aliased usage is unverified.

```ts
export declare const uninterruptible: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
```

## uninterruptibleMask

Disables interruption and provides a restore function to restore the interruptible state within the effect.

Source: `effect@4.0.2/src/Effect.ts:15223`.

Vivid `Effect.uninterruptibleMask` matches: 8. apps/server/src/computers/device.ts:637, apps/server/src/computers/device.ts:642, apps/server/src/computers/ssh/link.ts:694 Bare-name matches: 8. Aliased usage is unverified.

```ts
export declare const uninterruptibleMask: <A, E, R>(f: (restore: <AX, EX, RX>(effect: Effect<AX, EX, RX>) => Effect<AX, EX, RX>) => Effect<A, E, R>) => Effect<A, E, R>;
```

## interruptibleMask

Runs an effect in an interruptible region while providing `restore` for locally restoring the previous interruptibility.

Source: `effect@4.0.2/src/Effect.ts:15261`.

Vivid `Effect.interruptibleMask` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interruptibleMask: <A, E, R>(f: (restore: <AX, EX, RX>(effect: Effect<AX, EX, RX>) => Effect<AX, EX, RX>) => Effect<A, E, R>) => Effect<A, E, R>;
```

## abortSignal

Creates an AbortSignal that is managed by the provided scope.

Source: `effect@4.0.2/src/Effect.ts:15292`.

Vivid `Effect.abortSignal` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const abortSignal: Effect<AbortSignal, never, Scope>;
```

## Repeat

Type helpers for repeating effects.

Source: `effect@4.0.2/src/Effect.ts:15305`.

Vivid `Effect.Repeat` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare namespace Repeat {
    type Return<R, E, A, O extends Options<A>> = Effect<O extends unknown ? "schedule" extends keyof O ? A : "times" extends keyof O ? A : O extends {
        until: Predicate.Refinement<A, infer B>;
    } ? B : O extends {
        while: Predicate.Refinement<A, infer B>;
    } ? Exclude<A, B> : A : never, E | (O extends {
        schedule: Schedule<infer _Out, infer _I, infer E, infer _R>;
    } ? E : never) | (O extends {
        while: (...args: Array<any>) => Effect<infer _A, infer E, infer _R>;
    } ? E : never) | (O extends {
        until: (...args: Array<any>) => Effect<infer _A, infer E, infer _R>;
    } ? E : never), R | (O extends {
        schedule: Schedule<infer _O, infer _I, infer _E, infer R>;
    } ? R : never) | (O extends {
        while: (...args: Array<any>) => Effect<infer _A, infer _E, infer R>;
    } ? R : never) | (O extends {
        until: (...args: Array<any>) => Effect<infer _A, infer _E, infer R>;
    } ? R : never)> extends infer Z ? Z : never;
    interface Options<A> {
        while?: ((_: A) => boolean | Effect<boolean, any, any>) | undefined;
        until?: ((_: A) => boolean | Effect<boolean, any, any>) | undefined;
        times?: number | undefined;
        schedule?: Schedule<any, A, any, any> | undefined;
    }
}
```

## forever

Repeats this effect forever (until the first error).

Source: `effect@4.0.2/src/Effect.ts:15370`.

Vivid `Effect.forever` matches: 17. apps/desktop/src/main/computer.ts:364, apps/desktop/src/main/device.ts:339, apps/desktop/src/main/egress.ts:694 Bare-name matches: 32. Aliased usage is unverified.

```ts
export declare const forever: <Arg extends Effect<any, any, any> | {
    readonly disableYield?: boolean | undefined;
} | undefined = {
    readonly disableYield?: boolean | undefined;
}>(effectOrOptions?: Arg, options?: {
    readonly disableYield?: boolean | undefined;
} | undefined) => [
    Arg
] extends [
    Effect<infer _A, infer _E, infer _R>
] ? Effect<never, _E, _R> : <A, E, R>(self: Effect<A, E, R>) => Effect<never, E, R>;
```

## repeat

Repeats an effect based on a specified schedule or until the first failure.

Source: `effect@4.0.2/src/Effect.ts:15465`.

Vivid `Effect.repeat` matches: 11. apps/server/src/approvals/sweeper.ts:33, apps/server/src/channels/worker.ts:59, apps/server/src/computers/store.ts:935 Bare-name matches: 107. Aliased usage is unverified.

```ts
export declare const repeat: {
    <O extends Repeat.Options<A>, A>(options: O): <E, R>(self: Effect<A, E, R>) => Repeat.Return<R, E, A, O>;
    <Output, Input, Error, Env>(schedule: Schedule<Output, NoInfer<Input>, Error, Env>): <E, R>(self: Effect<Input, E, R>) => Effect<Output, E | Error, R | Env>;
    <Output, Input, Error, Env>(builder: ($: <O, E, R>(_: Schedule<O, NoInfer<Input>, E, R>) => Schedule<O, Input, E, R>) => Schedule<Output, NoInfer<Input>, Error, Env>): <E, R>(self: Effect<Input, E, R>) => Effect<Output, E | Error, R | Env>;
    <A, E, R, O extends Repeat.Options<A>>(self: Effect<A, E, R>, options: O): Repeat.Return<R, E, A, O>;
    <Input, E, R, Output, Error, Env>(self: Effect<Input, E, R>, schedule: Schedule<Output, NoInfer<Input>, Error, Env>): Effect<Output, E | Error, R | Env>;
    <Input, E, R, Output, Error, Env>(self: Effect<Input, E, R>, builder: ($: <O, E, R>(_: Schedule<O, NoInfer<Input>, E, R>) => Schedule<O, Input, E, R>) => Schedule<Output, NoInfer<Input>, Error, Env>): Effect<Output, E | Error, R | Env>;
};
```

## repeatOrElse

Repeats an effect according to a schedule and runs a fallback effect if repetition fails before the schedule completes.

Source: `effect@4.0.2/src/Effect.ts:16024`.

Vivid `Effect.repeatOrElse` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const repeatOrElse: {
    <R2, A, B, E, E2, E3, R3>(schedule: Schedule<B, A, E2, R2>, orElse: (error: E | E2, option: Option<ScheduleMetadata<B, A>>) => Effect<B, E3, R3>): <R>(self: Effect<A, E, R>) => Effect<B, E3, R | R2 | R3>;
    <A, E, R, R2, B, E2, E3, R3>(self: Effect<A, E, R>, schedule: Schedule<B, A, E2, R2>, orElse: (error: E | E2, option: Option<ScheduleMetadata<B, A>>) => Effect<B, E3, R3>): Effect<B, E3, R | R2 | R3>;
};
```

## replicate

Returns an array of `n` identical effects.

Source: `effect@4.0.2/src/Effect.ts:16159`.

Vivid `Effect.replicate` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const replicate: {
    (n: number): <A, E, R>(self: Effect<A, E, R>) => Array<Effect<A, E, R>>;
    <A, E, R>(self: Effect<A, E, R>, n: number): Array<Effect<A, E, R>>;
};
```

## replicateEffect

Performs this effect `n` times and collects results with `Effect.all` semantics.

Source: `effect@4.0.2/src/Effect.ts:16233`.

Vivid `Effect.replicateEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const replicateEffect: {
    (n: number, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: false | undefined;
    }): <A, E, R>(self: Effect<A, E, R>) => Effect<Array<A>, E, R>;
    (n: number, options: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard: true;
    }): <A, E, R>(self: Effect<A, E, R>) => Effect<void, E, R>;
    <A, E, R>(self: Effect<A, E, R>, n: number, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard?: false | undefined;
    }): Effect<Array<A>, E, R>;
    <A, E, R>(self: Effect<A, E, R>, n: number, options: {
        readonly concurrency?: Concurrency | undefined;
        readonly discard: true;
    }): Effect<void, E, R>;
};
```

## schedule

Runs an effect repeatedly according to a schedule and returns the schedule's final output.

Source: `effect@4.0.2/src/Effect.ts:16419`.

Vivid `Effect.schedule` matches: 0. No qualified match. Bare-name matches: 98. Aliased usage is unverified.

```ts
export declare const schedule: {
    <Output, Error, Env>(schedule: Schedule<Output, unknown, Error, Env>): <A, E, R>(self: Effect<A, E, R>) => Effect<Output, E | Error, R | Env>;
    <A, E, R, Output, Error, Env>(self: Effect<A, E, R>, schedule: Schedule<Output, unknown, Error, Env>): Effect<Output, E | Error, R | Env>;
};
```

## scheduleFrom

Runs an effect repeatedly according to a schedule that is initialized with a specific schedule input.

Source: `effect@4.0.2/src/Effect.ts:16548`.

Vivid `Effect.scheduleFrom` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const scheduleFrom: {
    <Input, Output, Error, Env>(initial: Input, schedule: Schedule<Output, Input, Error, Env>): <E, R>(self: Effect<Input, E, R>) => Effect<Output, E | Error, R | Env>;
    <Input, E, R, Output, Error, Env>(self: Effect<Input, E, R>, initial: Input, schedule: Schedule<Output, Input, Error, Env>): Effect<Output, E | Error, R | Env>;
};
```

## request

Executes a request using the provided resolver.

Source: `effect@4.0.2/src/Effect.ts:17777`.

Vivid `Effect.request` matches: 1. apps/server/src/connections/effects.ts:328 Bare-name matches: 2828. Aliased usage is unverified.

```ts
export declare const request: {
    <A extends Request.Any, EX = never, RX = never>(resolver: RequestResolver<A> | Effect<RequestResolver<A>, EX, RX>): (self: A) => Effect<Request.Success<A>, Request.Error<A> | EX, Request.Services<A> | RX>;
    <A extends Request.Any, EX = never, RX = never>(self: A, resolver: RequestResolver<A> | Effect<RequestResolver<A>, EX, RX>): Effect<Request.Success<A>, Request.Error<A> | EX, Request.Services<A> | RX>;
};
```

## requestUnsafe

Registers a request with a resolver and delivers the exit value via `onExit`.

Source: `effect@4.0.2/src/Effect.ts:17892`.

Vivid `Effect.requestUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const requestUnsafe: <A extends Request.Any>(self: A, options: {
    readonly resolver: RequestResolver<A>;
    readonly onExit: (exit: Exit.Exit<Request.Success<A>, Request.Error<A>>) => void;
    readonly context: Context.Context<never>;
}) => () => void;
```

## forkChild

Returns an effect that forks this effect into its own separate fiber, returning the fiber immediately, without waiting for it to begin executing the effect.

Source: `effect@4.0.2/src/Effect.ts:17948`.

Vivid `Effect.forkChild` matches: 57. apps/desktop/scripts/control.ts:169, apps/desktop/scripts/control.ts:241, apps/desktop/src/main/computer.test.ts:188 Bare-name matches: 57. Aliased usage is unverified.

```ts
export declare const forkChild: <Arg extends Effect<any, any, any> | {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
} | undefined = {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
}>(effectOrOptions?: Arg, options?: {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
} | undefined) => [
    Arg
] extends [
    Effect<infer _A, infer _E, infer _R>
] ? Effect<Fiber<_A, _E>, never, _R> : <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R>;
```

## forkIn

Forks the effect in the specified scope. The fiber will be interrupted when the scope is closed.

Source: `effect@4.0.2/src/Effect.ts:17992`.

Vivid `Effect.forkIn` matches: 13. apps/desktop/src/main/signin.ts:458, apps/desktop/src/main/turn.ts:299, apps/server/src/computers/store.ts:734 Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const forkIn: {
    (scope: Scope, options?: {
        readonly startImmediately?: boolean | undefined;
        readonly uninterruptible?: boolean | "inherit" | undefined;
    }): <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R>;
    <A, E, R>(self: Effect<A, E, R>, scope: Scope, options?: {
        readonly startImmediately?: boolean | undefined;
        readonly uninterruptible?: boolean | "inherit" | undefined;
    }): Effect<Fiber<A, E>, never, R>;
};
```

## forkScoped

Forks the fiber in a `Scope`, interrupting it when the scope is closed.

Source: `effect@4.0.2/src/Effect.ts:18090`.

Vivid `Effect.forkScoped` matches: 128. apps/desktop/src/main/computer.ts:363, apps/desktop/src/main/computer.ts:368, apps/desktop/src/main/control.live.test.ts:202 Bare-name matches: 128. Aliased usage is unverified.

```ts
export declare const forkScoped: <Arg extends Effect<any, any, any> | {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
} | undefined = {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
}>(effectOrOptions?: Arg, options?: {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
} | undefined) => [
    Arg
] extends [
    Effect<infer _A, infer _E, infer _R>
] ? Effect<Fiber<_A, _E>, never, _R | Scope> : <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R | Scope>;
```

## forkDetach

Forks the effect into a new fiber attached to the global scope. Because the new fiber is attached to the global scope, when the fiber executing the returned effect terminates, the forked fiber will continue running.

Source: `effect@4.0.2/src/Effect.ts:18131`.

Vivid `Effect.forkDetach` matches: 3. apps/desktop/src/main/main.ts:344, apps/desktop/src/main/main.ts:346, packages/agent/runtime/src/notes.ts:280 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const forkDetach: <Arg extends Effect<any, any, any> | {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
} | undefined = {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
}>(effectOrOptions?: Arg, options?: {
    readonly startImmediately?: boolean | undefined;
    readonly uninterruptible?: boolean | "inherit" | undefined;
} | undefined) => [
    Arg
] extends [
    Effect<infer _A, infer _E, infer _R>
] ? Effect<Fiber<_A, _E>, never, _R> : <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R>;
```

## awaitAllChildren

Waits for all child fibers forked by this effect to complete before this effect completes.

Source: `effect@4.0.2/src/Effect.ts:18175`.

Vivid `Effect.awaitAllChildren` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitAllChildren: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>;
```

## fiber

Accesses the fiber currently executing the effect.

Source: `effect@4.0.2/src/Effect.ts:18199`.

Vivid `Effect.fiber` matches: 0. No qualified match. Bare-name matches: 143. Aliased usage is unverified.

```ts
export declare const fiber: Effect<Fiber<unknown, unknown>>;
```

## fiberId

Accesses the current fiber id executing the effect.

Source: `effect@4.0.2/src/Effect.ts:18217`.

Vivid `Effect.fiberId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const fiberId: Effect<number>;
```

## RunOptions

Configuration options for running Effect programs, providing control over interruption and scheduling behavior.

Source: `effect@4.0.2/src/Effect.ts:18247`.

Vivid `Effect.RunOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface RunOptions {
    readonly signal?: AbortSignal | undefined;
    readonly scheduler?: Scheduler | undefined;
    readonly uninterruptible?: boolean | undefined;
    readonly onFiberStart?: ((fiber: Fiber<unknown, unknown>) => void) | undefined;
}
```

## runFork

Runs an effect in the background, returning a fiber that can be observed or interrupted.

Source: `effect@4.0.2/src/Effect.ts:18284`.

Vivid `Effect.runFork` matches: 5. apps/mobile/src/data/app.ts:20, apps/mobile/src/data/app.ts:22, apps/web/src/data/app.ts:36 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const runFork: <A, E>(effect: Effect<A, E, never>, options?: RunOptions | undefined) => Fiber<A, E>;
```

## runForkWith

Runs an effect in the background with the provided services.

Source: `effect@4.0.2/src/Effect.ts:18326`.

Vivid `Effect.runForkWith` matches: 3. apps/desktop/src/main/main.ts:230, apps/desktop/src/main/main.ts:381, apps/desktop/src/main/main.ts:471 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const runForkWith: <R>(context: Context.Context<R>) => <A, E>(effect: Effect<A, E, R>, options?: RunOptions | undefined) => Fiber<A, E>;
```

## clockWith

Retrieves the `Clock` service from the context and provides it to the specified effectful function.

Source: `effect@4.0.2/src/Effect.ts:23139`.

Vivid `Effect.clockWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const clockWith: <A, E, R>(f: (clock: Clock) => Effect<A, E, R>) => Effect<A, E, R>;
```

## Transaction

Service that holds the current transaction state.

Source: `effect@4.0.2/src/Effect.ts:25279`.

Vivid `Effect.Transaction` matches: 0. No qualified match. Bare-name matches: 42. Aliased usage is unverified.

```ts
export declare class Transaction extends Transaction_base {
}
```

## tx

Defines a transaction boundary. Transactions are "all or nothing" with respect to changes made to transactional values (i.e. TxRef) that occur within the transaction body.

Source: `effect@4.0.2/src/Effect.ts:25341`.

Vivid `Effect.tx` matches: 0. No qualified match. Bare-name matches: 287. Aliased usage is unverified.

```ts
export declare const tx: <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, Exclude<R, Transaction>>;
```

## txRetry

Retries the current transaction by signaling that it must be retried.

Source: `effect@4.0.2/src/Effect.ts:25480`.

Vivid `Effect.txRetry` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const txRetry: Effect<never, never, Transaction>;
```
