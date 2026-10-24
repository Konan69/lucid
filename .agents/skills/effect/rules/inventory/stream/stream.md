# Stream

Import `effect/Stream`. Source `effect@4.0.2/src/Stream.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 248. Module-name matches in Vivid: 346. apps/desktop/src/main/device.ts:25, apps/desktop/src/main/device.ts:74, apps/desktop/src/main/device.ts:106

## TypeId

Runtime identifier stored on `Stream` values and used by `isStream` to recognize them.

Source: `effect@4.0.2/src/Stream.ts:100`.

Vivid `Stream.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type TypeId = "~effect/Stream";
export declare const TypeId: TypeId;
```

## Stream

A `Stream<A, E, R>` describes a program that can emit many `A` values, fail with `E`, and require `R`.

Source: `effect@4.0.2/src/Stream.ts:130`.

Vivid `Stream.Stream` matches: 23. apps/desktop/src/main/device.ts:74, apps/mobile/src/data/drafts.ts:88, apps/server/src/channels/provider.ts:66 Bare-name matches: 346. Aliased usage is unverified.

```ts
export interface Stream<out A, out E = never, out R = never> extends Variance<A, E, R>, Pipeable {
    readonly channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A>, E, void, unknown, unknown, unknown, R>;
    [Unify.typeSymbol]?: unknown;
    [Unify.unifySymbol]?: StreamUnify<this>;
    [Unify.ignoreSymbol]?: StreamUnifyIgnore;
}
```

## StreamUnify

Type-level unification hook for Stream within the Effect type system.

Source: `effect@4.0.2/src/Stream.ts:144`.

Vivid `Stream.StreamUnify` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface StreamUnify<A extends {
    [Unify.typeSymbol]?: any;
}> extends Effect.EffectUnify<A> {
    Stream?: () => A[Unify.typeSymbol] extends Stream<infer A0, infer E0, infer R0> | infer _ ? Stream<A0, E0, R0> : never;
}
```

## StreamUnifyIgnore

Type-level marker that excludes Stream from unification.

Source: `effect@4.0.2/src/Stream.ts:155`.

Vivid `Stream.StreamUnifyIgnore` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface StreamUnifyIgnore {
    Effect?: true;
}
```

## StreamTypeLambda

Type lambda for Stream used in higher-kinded type operations.

Source: `effect@4.0.2/src/Stream.ts:178`.

Vivid `Stream.StreamTypeLambda` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface StreamTypeLambda extends TypeLambda {
    readonly type: Stream<this["Target"], this["Out1"], this["Out2"]>;
}
```

## Variance

Type-level variance marker for `Stream`.

Source: `effect@4.0.2/src/Stream.ts:194`.

Vivid `Stream.Variance` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Variance<out A, out E, out R> {
    readonly [TypeId]: VarianceStruct<A, E, R>;
}
```

## VarianceStruct

Structural encoding used by `Variance` to record each `Stream` type parameter's variance.

Source: `effect@4.0.2/src/Stream.ts:210`.

Vivid `Stream.VarianceStruct` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface VarianceStruct<out A, out E, out R> {
    readonly _A: Covariant<A>;
    readonly _E: Covariant<E>;
    readonly _R: Covariant<R>;
}
```

## Success

Extract the success type from a Stream type.

Source: `effect@4.0.2/src/Stream.ts:233`.

Vivid `Stream.Success` matches: 0. No qualified match. Bare-name matches: 102. Aliased usage is unverified.

```ts
export type Success<T> = T extends Stream<infer _A, infer _E, infer _R> ? _A : never;
```

## Error

Extract the error type from a Stream type.

Source: `effect@4.0.2/src/Stream.ts:252`.

Vivid `Stream.Error` matches: 0. No qualified match. Bare-name matches: 149. Aliased usage is unverified.

```ts
export type Error<T> = T extends Stream<infer _A, infer _E, infer _R> ? _E : never;
```

## Services

Extract the services type from a Stream type.

Source: `effect@4.0.2/src/Stream.ts:275`.

Vivid `Stream.Services` matches: 0. No qualified match. Bare-name matches: 23. Aliased usage is unverified.

```ts
export type Services<T> = T extends Stream<infer _A, infer _E, infer _R> ? _R : never;
```

## isStream

Checks whether a value is a Stream.

Source: `effect@4.0.2/src/Stream.ts:293`.

Vivid `Stream.isStream` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isStream: (u: unknown) => u is Stream<unknown, unknown, unknown>;
```

## DefaultChunkSize

The default chunk size used by Stream constructors and combinators.

Source: `effect@4.0.2/src/Stream.ts:310`.

Vivid `Stream.DefaultChunkSize` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const DefaultChunkSize: number;
```

## HaltStrategy

Describes how merged streams decide when to halt.

Source: `effect@4.0.2/src/Stream.ts:319`.

Vivid `Stream.HaltStrategy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type HaltStrategy = Channel.HaltStrategy;
```

## fromChannel

Creates a stream from a array-emitting `Channel`.

Source: `effect@4.0.2/src/Stream.ts:338`.

Vivid `Stream.fromChannel` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromChannel: <Arr extends Arr.NonEmptyReadonlyArray<any>, E, R>(channel: Channel.Channel<Arr, E, void, unknown, unknown, unknown, R>) => Stream<Arr extends Arr.NonEmptyReadonlyArray<infer A> ? A : never, E, R>;
```

## fromEffect

Creates a stream from an effect.

Source: `effect@4.0.2/src/Stream.ts:358`.

Vivid `Stream.fromEffect` matches: 2. apps/server/src/live/query.ts:66, apps/server/src/runtime/settlement.ts:176 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const fromEffect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Stream<A, E, R>;
```

## service

Accesses a service from the context and emits it as a single element.

Source: `effect@4.0.2/src/Stream.ts:391`.

Vivid `Stream.service` matches: 0. No qualified match. Bare-name matches: 1524. Aliased usage is unverified.

```ts
export declare const service: <I, S>(service: Context.Key<I, S>) => Stream<S, never, I>;
```

## serviceOption

Optionally accesses a service from the context and emits the result as a single element.

Source: `effect@4.0.2/src/Stream.ts:434`.

Vivid `Stream.serviceOption` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const serviceOption: <I, S>(service: Context.Key<I, S>) => Stream<Option.Option<S>>;
```

## fromEffectDrain

Creates a stream that runs the effect and emits no elements.

Source: `effect@4.0.2/src/Stream.ts:458`.

Vivid `Stream.fromEffectDrain` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromEffectDrain: <A, E, R>(effect: Effect.Effect<A, E, R>) => Stream<never, E, R>;
```

## fromEffectRepeat

Creates a stream from an effect producing a value of type `A` which repeats forever.

Source: `effect@4.0.2/src/Stream.ts:478`.

Vivid `Stream.fromEffectRepeat` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromEffectRepeat: <A, E, R>(effect: Effect.Effect<A, E, R>) => Stream<A, Pull.ExcludeDone<E>, R>;
```

## fromEffectSchedule

Creates a stream from an effect producing a value of type `A`, which is repeated using the specified schedule.

Source: `effect@4.0.2/src/Stream.ts:498`.

Vivid `Stream.fromEffectSchedule` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromEffectSchedule: <A, E, R, X, AS extends A, ES, RS>(effect: Effect.Effect<A, E, R>, schedule: Schedule.Schedule<X, AS, ES, RS>) => Stream<A, E | ES, R | RS>;
```

## tick

Creates a stream that emits `void` immediately once, then emits another `void` after each specified interval.

Source: `effect@4.0.2/src/Stream.ts:538`.

Vivid `Stream.tick` matches: 2. apps/server/src/computers/egress/relay.ts:409, apps/server/src/computers/screen.ts:82 Bare-name matches: 63. Aliased usage is unverified.

```ts
export declare const tick: (interval: Duration.Input) => Stream<void>;
```

## fromPull

Creates a stream from a pull effect, such as one produced by `Stream.toPull`.

Source: `effect@4.0.2/src/Stream.ts:581`.

Vivid `Stream.fromPull` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromPull: <A, E, R, EX, RX>(pull: Effect.Effect<Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R>, EX, RX>) => Stream<A, Pull.ExcludeDone<E> | EX, R | RX>;
```

## transformPull

Derives a stream by transforming its pull effect.

Source: `effect@4.0.2/src/Stream.ts:604`.

Vivid `Stream.transformPull` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const transformPull: <A, E, R, B, E2, R2, EX, RX>(self: Stream<A, E, R>, f: (pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void>, scope: Scope.Scope) => Effect.Effect<Pull.Pull<Arr.NonEmptyReadonlyArray<B>, E2, void, R2>, EX, RX>) => Stream<B, EX | Pull.ExcludeDone<E2>, R | R2 | RX>;
```

## transformPullBracket

Transforms a stream by effectfully transforming its pull effect.

Source: `effect@4.0.2/src/Stream.ts:651`.

Vivid `Stream.transformPullBracket` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const transformPullBracket: <A, E, R, B, E2, R2, EX, RX>(self: Stream<A, E, R>, f: (pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R>, scope: Scope.Scope, forkedScope: Scope.Scope) => Effect.Effect<Pull.Pull<Arr.NonEmptyReadonlyArray<B>, E2, void, R2>, EX, RX>) => Stream<B, EX | Pull.ExcludeDone<E2>, R | R2 | RX>;
```

## toChannel

Creates a channel from a stream.

Source: `effect@4.0.2/src/Stream.ts:686`.

Vivid `Stream.toChannel` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toChannel: <A, E, R>(stream: Stream<A, E, R>) => Channel.Channel<Arr.NonEmptyReadonlyArray<A>, E, void, unknown, unknown, unknown, R>;
```

## callback

Creates a stream from a callback that can emit values into a queue.

Source: `effect@4.0.2/src/Stream.ts:725`.

Vivid `Stream.callback` matches: 1. apps/mobile/src/data/signing.ts:88 Bare-name matches: 256. Aliased usage is unverified.

```ts
export declare const callback: <A, E = never, R = never>(f: (queue: Queue.Queue<A, E | Cause.Done>) => Effect.Effect<unknown, E, R | Scope.Scope>, options?: {
    readonly bufferSize?: number | undefined;
    readonly strategy?: "sliding" | "dropping" | "suspend" | undefined;
}) => Stream<A, E, Exclude<R, Scope.Scope>>;
```

## empty

Creates an empty stream.

Source: `effect@4.0.2/src/Stream.ts:748`.

Vivid `Stream.empty` matches: 3. apps/server/src/http/upload.ts:77, apps/server/src/notifications/store.test.ts:26, apps/server/src/threads/gateway.ts:252 Bare-name matches: 378. Aliased usage is unverified.

```ts
export declare const empty: Stream<never>;
```

## succeed

Creates a single-valued pure stream.

Source: `effect@4.0.2/src/Stream.ts:765`.

Vivid `Stream.succeed` matches: 1. apps/mobile/src/data/drafts.ts:90 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const succeed: <A>(value: A) => Stream<A>;
```

## make

Creates a stream from a sequence of values.

Source: `effect@4.0.2/src/Stream.ts:784`.

Vivid `Stream.make` matches: 6. apps/server/src/computers/screen.ts:82, apps/server/src/computers/store.test.ts:581, apps/server/src/connections/transport.test.ts:1441 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <const As extends ReadonlyArray<any>>(...values: As) => Stream<As[number]>;
```

## sync

Creates a stream that synchronously evaluates a function and emits the result as a single value.

Source: `effect@4.0.2/src/Stream.ts:805`.

Vivid `Stream.sync` matches: 0. No qualified match. Bare-name matches: 487. Aliased usage is unverified.

```ts
export declare const sync: <A>(evaluate: LazyArg<A>) => Stream<A>;
```

## suspend

Creates a lazily constructed stream.

Source: `effect@4.0.2/src/Stream.ts:826`.

Vivid `Stream.suspend` matches: 0. No qualified match. Bare-name matches: 52. Aliased usage is unverified.

```ts
export declare const suspend: <A, E, R>(stream: LazyArg<Stream<A, E, R>>) => Stream<A, E, R>;
```

## fail

Terminates with the specified error.

Source: `effect@4.0.2/src/Stream.ts:844`.

Vivid `Stream.fail` matches: 4. apps/server/src/channels/testing.ts:127, apps/server/src/computers/boat.ts:91, apps/server/src/computers/store.test.ts:280 Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: <E>(error: E) => Stream<never, E>;
```

## failSync

Terminates with the specified lazily evaluated error.

Source: `effect@4.0.2/src/Stream.ts:863`.

Vivid `Stream.failSync` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const failSync: <E>(evaluate: LazyArg<E>) => Stream<never, E>;
```

## failCause

Creates a stream that fails with the specified `Cause`.

Source: `effect@4.0.2/src/Stream.ts:884`.

Vivid `Stream.failCause` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const failCause: <E>(cause: Cause.Cause<E>) => Stream<never, E>;
```

## die

The stream that dies with the specified defect.

Source: `effect@4.0.2/src/Stream.ts:904`.

Vivid `Stream.die` matches: 1. apps/server/src/computers/shell.test.ts:93 Bare-name matches: 95. Aliased usage is unverified.

```ts
export declare const die: (defect: unknown) => Stream<never>;
```

## failCauseSync

The stream that always fails with the specified lazily evaluated `Cause`.

Source: `effect@4.0.2/src/Stream.ts:925`.

Vivid `Stream.failCauseSync` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const failCauseSync: <E>(evaluate: LazyArg<Cause.Cause<E>>) => Stream<never, E>;
```

## fromIteratorSucceed

Creates a stream that consumes values from an iterator.

Source: `effect@4.0.2/src/Stream.ts:962`.

Vivid `Stream.fromIteratorSucceed` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromIteratorSucceed: <A>(iterator: IterableIterator<A>, maxChunkSize?: number) => Stream<A>;
```

## fromIterable

Creates a new `Stream` from an iterable collection of values.

Source: `effect@4.0.2/src/Stream.ts:994`.

Vivid `Stream.fromIterable` matches: 2. apps/mobile/src/data/connecting.ts:180, apps/web/src/data/connecting.ts:131 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const fromIterable: <A>(iterable: Iterable<A>, options?: {
    readonly chunkSize?: number | undefined;
}) => Stream<A>;
```

## fromIterableEffect

Creates a stream from an effect producing an iterable of values.

Source: `effect@4.0.2/src/Stream.ts:1044`.

Vivid `Stream.fromIterableEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromIterableEffect: <A, E, R>(iterable: Effect.Effect<Iterable<A>, E, R>) => Stream<A, E, R>;
```

## fromIterableEffectRepeat

Creates a stream by repeatedly running an effect that yields an iterable of values.

Source: `effect@4.0.2/src/Stream.ts:1070`.

Vivid `Stream.fromIterableEffectRepeat` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromIterableEffectRepeat: <A, E, R>(iterable: Effect.Effect<Iterable<A>, E, R>) => Stream<A, Pull.ExcludeDone<E>, R>;
```

## fromArray

Creates a stream from an array of values.

Source: `effect@4.0.2/src/Stream.ts:1095`.

Vivid `Stream.fromArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromArray: <A>(array: ReadonlyArray<A>) => Stream<A>;
```

## fromArrayEffect

Creates a stream from an effect that produces an array of values.

Source: `effect@4.0.2/src/Stream.ts:1124`.

Vivid `Stream.fromArrayEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromArrayEffect: <A, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) => Stream<A, Pull.ExcludeDone<E>, R>;
```

## fromArrays

Creates a stream from an arbitrary number of arrays.

Source: `effect@4.0.2/src/Stream.ts:1149`.

Vivid `Stream.fromArrays` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromArrays: <Arr extends ReadonlyArray<ReadonlyArray<any>>>(...arrays: Arr) => Stream<Arr[number][number]>;
```

## fromQueue

Creates a stream that pulls values from a `Queue.Dequeue`.

Source: `effect@4.0.2/src/Stream.ts:1185`.

Vivid `Stream.fromQueue` matches: 16. apps/desktop/src/main/device.ts:289, apps/server/src/auth/dialect.test.ts:166, apps/server/src/channels/testing.ts:128 Bare-name matches: 16. Aliased usage is unverified.

```ts
export declare const fromQueue: <A, E>(queue: Queue.Dequeue<A, E>) => Stream<A, Exclude<E, Cause.Done>>;
```

## fromPubSub

Creates a stream from a subscription to a `PubSub`.

Source: `effect@4.0.2/src/Stream.ts:1220`.

Vivid `Stream.fromPubSub` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromPubSub: <A>(pubsub: PubSub.PubSub<A>) => Stream<A>;
```

## fromPubSubTake

Creates a stream from a PubSub of `Take` values.

Source: `effect@4.0.2/src/Stream.ts:1254`.

Vivid `Stream.fromPubSubTake` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromPubSubTake: <A, E>(pubsub: PubSub.PubSub<Take.Take<A, E>>) => Stream<A, E>;
```

## fromReadableStream

Creates a stream from a lazily supplied Web `ReadableStream`.

Source: `effect@4.0.2/src/Stream.ts:1298`.

Vivid `Stream.fromReadableStream` matches: 1. apps/server/src/http/upload.ts:78 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const fromReadableStream: <A, E>(options: {
    readonly evaluate: LazyArg<ReadableStream<A>>;
    readonly onError: (error: unknown) => E;
    readonly releaseLockOnEnd?: boolean | undefined;
}) => Stream<A, E>;
```

## fromAsyncIterable

Creates a stream from an AsyncIterable.

Source: `effect@4.0.2/src/Stream.ts:1334`.

Vivid `Stream.fromAsyncIterable` matches: 1. apps/server/src/channels/photon.ts:192 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const fromAsyncIterable: <A, E>(iterable: AsyncIterable<A>, onError: (error: unknown) => E) => Stream<A, E>;
```

## fromSchedule

Creates a stream that emits each output of a schedule that does not require input, for as long as the schedule continues.

Source: `effect@4.0.2/src/Stream.ts:1362`.

Vivid `Stream.fromSchedule` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromSchedule: <O, E, R>(schedule: Schedule.Schedule<O, unknown, E, R>) => Stream<O, E, R>;
```

## fromSubscription

Creates a stream from a PubSub subscription.

Source: `effect@4.0.2/src/Stream.ts:1403`.

Vivid `Stream.fromSubscription` matches: 5. apps/server/src/computers/egress/relay.test.ts:133, apps/server/src/computers/screen.test.ts:102, apps/server/src/computers/store.test.ts:325 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const fromSubscription: <A>(pubsub: PubSub.Subscription<A>) => Stream<A>;
```

## EventListener

Interface representing an event listener target.

Source: `effect@4.0.2/src/Stream.ts:1413`.

Vivid `Stream.EventListener` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EventListener<A = unknown> {
    addEventListener(event: string, f: (event: A) => void, options?: {
        readonly capture?: boolean;
        readonly passive?: boolean;
        readonly once?: boolean;
        readonly signal?: AbortSignal;
    } | boolean): void;
    removeEventListener(event: string, f: (event: A) => void, options?: {
        readonly capture?: boolean;
    } | boolean): void;
}
```

## fromEventListener

Creates a stream from an event listener.

Source: `effect@4.0.2/src/Stream.ts:1466`.

Vivid `Stream.fromEventListener` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromEventListener: <A = unknown>(target: EventListener, type: string, options?: boolean | {
    readonly capture?: boolean;
    readonly passive?: boolean;
    readonly once?: boolean;
    readonly bufferSize?: number | undefined;
} | undefined) => Stream<A>;
```

## unfold

Creates a stream by repeatedly applying an effectful step function to a state.

Source: `effect@4.0.2/src/Stream.ts:1516`.

Vivid `Stream.unfold` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const unfold: <S, A, E, R>(s: S, f: (s: S) => Effect.Effect<readonly [
    A,
    S
] | undefined, E, R>) => Stream<A, E, R>;
```

## paginate

Creates a stream by repeatedly evaluating an effectful page function.

Source: `effect@4.0.2/src/Stream.ts:1562`.

Vivid `Stream.paginate` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const paginate: <S, A, E = never, R = never>(s: S, f: (s: S) => Effect.Effect<readonly [
    ReadonlyArray<A>,
    Option.Option<S>
], E, R>) => Stream<A, E, R>;
```

## iterate

Creates an infinite stream by repeatedly applying a function to a seed value.

Source: `effect@4.0.2/src/Stream.ts:1607`.

Vivid `Stream.iterate` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const iterate: <A>(value: A, next: (value: A) => A) => Stream<A>;
```

## range

Constructs a stream from a range of integers, including both endpoints.

Source: `effect@4.0.2/src/Stream.ts:1636`.

Vivid `Stream.range` matches: 0. No qualified match. Bare-name matches: 47. Aliased usage is unverified.

```ts
export declare const range: (min: number, max: number, chunkSize?: number) => Stream<number>;
```

## never

The stream that never produces any value or fails with any error.

Source: `effect@4.0.2/src/Stream.ts:1679`.

Vivid `Stream.never` matches: 13. apps/mobile/src/data/live.ts:350, apps/server/src/approvals/testing.ts:196, apps/server/src/artifacts/store.test.ts:92 Bare-name matches: 1556. Aliased usage is unverified.

```ts
export declare const never: Stream<never>;
```

## unwrap

Creates a stream produced from an `Effect`.

Source: `effect@4.0.2/src/Stream.ts:1704`.

Vivid `Stream.unwrap` matches: 15. apps/mobile/src/data/drafts.ts:113, apps/server/src/channels/photon.ts:210, apps/server/src/channels/testing.ts:122 Bare-name matches: 33. Aliased usage is unverified.

```ts
export declare const unwrap: <A, E2, R2, E, R>(effect: Effect.Effect<Stream<A, E2, R2>, E, R>) => Stream<A, E | E2, R2 | Exclude<R, Scope.Scope>>;
```

## scoped

Runs a stream that requires `Scope` in a managed scope, ensuring its finalizers are run when the stream completes.

Source: `effect@4.0.2/src/Stream.ts:1738`.

Vivid `Stream.scoped` matches: 0. No qualified match. Bare-name matches: 855. Aliased usage is unverified.

```ts
export declare const scoped: <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, Scope.Scope>>;
```

## map

Transforms the elements of this stream using the supplied function.

Source: `effect@4.0.2/src/Stream.ts:1758`.

Vivid `Stream.map` matches: 8. apps/mobile/src/data/drafts.ts:94, apps/mobile/src/data/drafts.ts:97, apps/mobile/src/data/drafts.ts:100 Bare-name matches: 1501. Aliased usage is unverified.

```ts
export declare const map: {
    <A, B>(f: (a: A, i: number) => B): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A, E, R, B>(self: Stream<A, E, R>, f: (a: A, i: number) => B): Stream<B, E, R>;
};
```

## as

Replaces every element of the stream with the provided constant value.

Source: `effect@4.0.2/src/Stream.ts:1827`.

Vivid `Stream.as` matches: 0. No qualified match. Bare-name matches: 5270. Aliased usage is unverified.

```ts
export declare const as: {
    <B>(value: B): <A, E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A, E, R, B>(self: Stream<A, E, R>, value: B): Stream<B, E, R>;
};
```

## mapBoth

Maps both the failure and success channels of a stream.

Source: `effect@4.0.2/src/Stream.ts:1917`.

Vivid `Stream.mapBoth` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapBoth: {
    <A, A2, E, E2>(options: {
        readonly onElement: (a: A) => A2;
        readonly onError: (e: E) => E2;
    }): <R>(self: Stream<A, E, R>) => Stream<A2, E2, R>;
    <A, E, R, A2, E2>(self: Stream<A, E, R>, options: {
        readonly onElement: (a: A) => A2;
        readonly onError: (e: E) => E2;
    }): Stream<A2, E2, R>;
};
```

## mapArray

Transforms each emitted chunk using the provided function, which receives the chunk and its index.

Source: `effect@4.0.2/src/Stream.ts:2028`.

Vivid `Stream.mapArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapArray: {
    <A, B>(f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Arr.NonEmptyReadonlyArray<B>): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A, E, R, B>(self: Stream<A, E, R>, f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Arr.NonEmptyReadonlyArray<B>): Stream<B, E, R>;
};
```

## mapEffect

Maps over elements of the stream with the specified effectful function.

Source: `effect@4.0.2/src/Stream.ts:2127`.

Vivid `Stream.mapEffect` matches: 14. apps/mobile/src/data/drafts.ts:104, apps/mobile/src/data/signing.ts:108, apps/server/src/auth/dialect.test.ts:168 Bare-name matches: 14. Aliased usage is unverified.

```ts
export declare const mapEffect: {
    <A, A2, E2, R2>(f: (a: A, i: number) => Effect.Effect<A2, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly unordered?: boolean | undefined;
    } | undefined): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (a: A, i: number) => Effect.Effect<A2, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly unordered?: boolean | undefined;
    } | undefined): Stream<A2, E | E2, R | R2>;
};
```

## flattenEffect

Flattens a stream of `Effect` values into a stream of their results.

Source: `effect@4.0.2/src/Stream.ts:2261`.

Vivid `Stream.flattenEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const flattenEffect: <Arg extends Stream<Effect.Effect<any, any, any>, any, any> | {
    readonly concurrency?: Concurrency | undefined;
    readonly unordered?: boolean | undefined;
} | undefined = {
    readonly concurrency?: Concurrency | undefined;
    readonly unordered?: boolean | undefined;
}>(selfOrOptions?: Arg, options?: {
    readonly concurrency?: Concurrency | undefined;
    readonly unordered?: boolean | undefined;
} | undefined) => [
    Arg
] extends [
    Stream<Effect.Effect<infer _A, infer _EX, infer _RX>, infer _E, infer _R>
] ? Stream<_A, _EX | _E, _RX | _R> : <A, EX, RX, E, R>(self: Stream<Effect.Effect<A, EX, RX>, E, R>) => Stream<A, EX | E, RX | R>;
```

## mapArrayEffect

Maps over non-empty array chunks emitted by the stream effectfully.

Source: `effect@4.0.2/src/Stream.ts:2319`.

Vivid `Stream.mapArrayEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapArrayEffect: {
    <A, B, E2, R2>(f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Effect.Effect<Arr.NonEmptyReadonlyArray<B>, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>;
    <A, E, R, B, E2, R2>(self: Stream<A, E, R>, f: (a: Arr.NonEmptyReadonlyArray<A>, i: number) => Effect.Effect<Arr.NonEmptyReadonlyArray<B>, E2, R2>): Stream<B, E | E2, R | R2>;
};
```

## result

Lifts failures and successes into a `Result`, yielding a stream that cannot fail.

Source: `effect@4.0.2/src/Stream.ts:2426`.

Vivid `Stream.result` matches: 0. No qualified match. Bare-name matches: 1410. Aliased usage is unverified.

```ts
export declare const result: <A, E, R>(self: Stream<A, E, R>) => Stream<Result.Result<A, E>, never, R>;
```

## tap

Runs the provided effect for each element while preserving the elements.

Source: `effect@4.0.2/src/Stream.ts:2460`.

Vivid `Stream.tap` matches: 2. apps/server/src/live/query.ts:68, apps/server/src/runtime/settlement.ts:151 Bare-name matches: 38. Aliased usage is unverified.

```ts
export declare const tap: {
    <A, X, E2, R2>(f: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
    } | undefined): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, X, E2, R2>(self: Stream<A, E, R>, f: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
    } | undefined): Stream<A, E | E2, R | R2>;
};
```

## tapBoth

Returns a stream that effectfully "peeks" at elements and failures.

Source: `effect@4.0.2/src/Stream.ts:2573`.

Vivid `Stream.tapBoth` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const tapBoth: {
    <A, E, X, E2, R2, Y, E3, R3>(options: {
        readonly onElement: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>;
        readonly onError: (a: NoInfer<E>) => Effect.Effect<Y, E3, R3>;
        readonly concurrency?: Concurrency | undefined;
    }): <R>(self: Stream<A, E, R>) => Stream<A, E | E2 | E3, R | R2 | R3>;
    <A, E, R, X, E2, R2, Y, E3, R3>(self: Stream<A, E, R>, options: {
        readonly onElement: (a: NoInfer<A>) => Effect.Effect<X, E2, R2>;
        readonly onError: (a: NoInfer<E>) => Effect.Effect<Y, E3, R3>;
        readonly concurrency?: Concurrency | undefined;
    }): Stream<A, E | E2 | E3, R | R2 | R3>;
};
```

## tapSink

Runs a sink for all stream elements while still emitting them downstream.

Source: `effect@4.0.2/src/Stream.ts:2691`.

Vivid `Stream.tapSink` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const tapSink: {
    <A, E2, R2>(sink: Sink.Sink<unknown, A, unknown, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<unknown, A, unknown, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## flatMap

Maps each element to a stream and flattens the resulting streams.

Source: `effect@4.0.2/src/Stream.ts:2853`.

Vivid `Stream.flatMap` matches: 2. apps/mobile/src/data/connecting.ts:179, apps/web/src/data/connecting.ts:130 Bare-name matches: 329. Aliased usage is unverified.

```ts
export declare const flatMap: {
    <A, A2, E2, R2>(f: (a: A) => Stream<A2, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
    } | undefined): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Stream<A2, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
    } | undefined): Stream<A2, E | E2, R | R2>;
};
```

## switchMap

Switches to the latest stream produced by the mapping function, interrupting the previous stream when a new element arrives.

Source: `effect@4.0.2/src/Stream.ts:2967`.

Vivid `Stream.switchMap` matches: 3. apps/server/src/live/query.ts:66, apps/server/src/live/query.ts:123, apps/server/src/runtime/settlement.ts:173 Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const switchMap: {
    <A, A2, E2, R2>(f: (a: A) => Stream<A2, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
    } | undefined): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Stream<A2, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
    } | undefined): Stream<A2, E | E2, R | R2>;
};
```

## flatten

Flattens a stream of streams into a single stream.

Source: `effect@4.0.2/src/Stream.ts:3078`.

Vivid `Stream.flatten` matches: 0. No qualified match. Bare-name matches: 10. Aliased usage is unverified.

```ts
export declare const flatten: <Arg extends Stream<Stream<any, any, any>, any, any> | {
    readonly concurrency?: Concurrency | undefined;
    readonly bufferSize?: number | undefined;
} | undefined = {
    readonly concurrency?: Concurrency | undefined;
    readonly bufferSize?: number | undefined;
}>(selfOrOptions?: Arg, options?: {
    readonly concurrency?: Concurrency | undefined;
    readonly bufferSize?: number | undefined;
} | undefined) => [
    Arg
] extends [
    Stream<Stream<infer _A, infer _E, infer _R>, infer _E2, infer _R2>
] ? Stream<_A, _E | _E2, _R | _R2> : <A, E, R, E2, R2>(self: Stream<Stream<A, E, R>, E2, R2>) => Stream<A, E | E2, R | R2>;
```

## flattenArray

Flattens a stream of non-empty arrays into a stream of elements.

Source: `effect@4.0.2/src/Stream.ts:3126`.

Vivid `Stream.flattenArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const flattenArray: <A, E, R>(self: Stream<Arr.NonEmptyReadonlyArray<A>, E, R>) => Stream<A, E, R>;
```

## drain

Converts this stream to one that runs its effects but emits no elements.

Source: `effect@4.0.2/src/Stream.ts:3149`.

Vivid `Stream.drain` matches: 0. No qualified match. Bare-name matches: 18. Aliased usage is unverified.

```ts
export declare const drain: <A, E, R>(self: Stream<A, E, R>) => Stream<never, E, R>;
```

## drainFork

Runs the provided stream in the background while this stream runs, interrupting it when this stream completes and failing if the background stream fails or defects.

Source: `effect@4.0.2/src/Stream.ts:3180`.

Vivid `Stream.drainFork` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const drainFork: {
    <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## repeat

Repeats the entire stream according to the provided schedule.

Source: `effect@4.0.2/src/Stream.ts:3271`.

Vivid `Stream.repeat` matches: 0. No qualified match. Bare-name matches: 107. Aliased usage is unverified.

```ts
export declare const repeat: {
    <B, E2, R2>(schedule: Schedule.Schedule<B, void, E2, R2> | (($: <SO, SE, SR>(_: Schedule.Schedule<SO, void, SE, SR>) => Schedule.Schedule<SO, void, SE, SR>) => Schedule.Schedule<B, void, E2, R2>)): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>;
    <A, E, R, B, E2, R2>(self: Stream<A, E, R>, schedule: Schedule.Schedule<B, void, E2, R2> | (($: <SO, SE, SR>(_: Schedule.Schedule<SO, void, SE, SR>) => Schedule.Schedule<SO, void, SE, SR>) => Schedule.Schedule<B, void, E2, R2>)): Stream<A, E | E2, R | R2>;
};
```

## schedule

Schedules the stream's elements according to the provided schedule.

Source: `effect@4.0.2/src/Stream.ts:3368`.

Vivid `Stream.schedule` matches: 0. No qualified match. Bare-name matches: 98. Aliased usage is unverified.

```ts
export declare const schedule: {
    <X, E2, R2, A>(schedule: Schedule.Schedule<X, NoInfer<A>, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>;
    <A, E, R, X, E2, R2>(self: Stream<A, E, R>, schedule: Schedule.Schedule<X, NoInfer<A>, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## timeout

Ends the stream if it does not produce a value within the specified duration.

Source: `effect@4.0.2/src/Stream.ts:3454`.

Vivid `Stream.timeout` matches: 0. No qualified match. Bare-name matches: 185. Aliased usage is unverified.

```ts
export declare const timeout: {
    (duration: Duration.Input): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, duration: Duration.Input): Stream<A, E, R>;
};
```

## timeoutOrElse

Switches to a fallback stream if this stream does not emit a value within the specified duration.

Source: `effect@4.0.2/src/Stream.ts:3539`.

Vivid `Stream.timeoutOrElse` matches: 0. No qualified match. Bare-name matches: 30. Aliased usage is unverified.

```ts
export declare const timeoutOrElse: {
    <B, E2, R2>(options: {
        readonly duration: Duration.Input;
        readonly orElse: () => Stream<B, E2, R2>;
    }): <A, E, R>(self: Stream<A, E, R>) => Stream<A | B, E | E2, R | R2>;
    <A, E, R, B, E2, R2>(self: Stream<A, E, R>, options: {
        readonly duration: Duration.Input;
        readonly orElse: () => Stream<B, E2, R2>;
    }): Stream<A | B, E | E2, R | R2>;
};
```

## repeatElements

Repeats each element of the stream according to the provided schedule, including the original emission.

Source: `effect@4.0.2/src/Stream.ts:3684`.

Vivid `Stream.repeatElements` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const repeatElements: {
    <B, E2, R2>(schedule: Schedule.Schedule<B, unknown, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>;
    <A, E, R, B, E2, R2>(self: Stream<A, E, R>, schedule: Schedule.Schedule<B, unknown, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## forever

Repeats this stream forever.

Source: `effect@4.0.2/src/Stream.ts:3797`.

Vivid `Stream.forever` matches: 0. No qualified match. Bare-name matches: 32. Aliased usage is unverified.

```ts
export declare const forever: <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
```

## flattenIterable

Flattens the iterables emitted by this stream into the stream's structure.

Source: `effect@4.0.2/src/Stream.ts:3820`.

Vivid `Stream.flattenIterable` matches: 1. apps/server/src/computers/boat.ts:94 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const flattenIterable: <A, E, R>(self: Stream<Iterable<A>, E, R>) => Stream<A, E, R>;
```

## flattenTake

Unwraps `Take` values, emitting elements from non-empty arrays and ending or failing when the `Exit` signals completion.

Source: `effect@4.0.2/src/Stream.ts:3850`.

Vivid `Stream.flattenTake` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const flattenTake: <A, E, E2, R>(self: Stream<Take.Take<A, E>, E2, R>) => Stream<A, E | E2, R>;
```

## concat

Concatenates two streams, emitting all elements from the first stream followed by all elements from the second stream.

Source: `effect@4.0.2/src/Stream.ts:3878`.

Vivid `Stream.concat` matches: 7. apps/mobile/src/data/drafts.ts:89, apps/server/src/computers/screen.ts:82, apps/server/src/computers/store.test.ts:581 Bare-name matches: 55. Aliased usage is unverified.

```ts
export declare const concat: {
    <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>;
};
```

## prepend

Prepends the values from the provided iterable before the stream's elements.

Source: `effect@4.0.2/src/Stream.ts:4036`.

Vivid `Stream.prepend` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const prepend: {
    <B>(values: Iterable<B>): <A, E, R>(self: Stream<A, E, R>) => Stream<B | A, E, R>;
    <A, E, R, B>(self: Stream<A, E, R>, values: Iterable<B>): Stream<A | B, E, R>;
};
```

## merge

Merges two streams, emitting elements from both as they arrive.

Source: `effect@4.0.2/src/Stream.ts:4120`.

Vivid `Stream.merge` matches: 2. apps/server/src/computers/egress/relay.ts:409, apps/server/src/computers/screen.ts:82 Bare-name matches: 41. Aliased usage is unverified.

```ts
export declare const merge: {
    <A2, E2, R2>(that: Stream<A2, E2, R2>, options?: {
        readonly haltStrategy?: HaltStrategy | undefined;
    } | undefined): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>, options?: {
        readonly haltStrategy?: HaltStrategy | undefined;
    } | undefined): Stream<A | A2, E | E2, R | R2>;
};
```

## mergeEffect

Merges this stream with a background effect, keeping the stream's elements.

Source: `effect@4.0.2/src/Stream.ts:4237`.

Vivid `Stream.mergeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mergeEffect: {
    <A2, E2, R2>(effect: Effect.Effect<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<A2, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## mergeResult

Merges this stream and the specified stream together, tagging values from the left stream as `Result.succeed` and values from the right stream as `Result.fail`.

Source: `effect@4.0.2/src/Stream.ts:4361`.

Vivid `Stream.mergeResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mergeResult: {
    <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<Result.Result<A, A2>, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<Result.Result<A, A2>, E | E2, R | R2>;
};
```

## mergeLeft

Merges two streams while emitting only the values from the left stream.

Source: `effect@4.0.2/src/Stream.ts:4489`.

Vivid `Stream.mergeLeft` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mergeLeft: {
    <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AL, ER | EL, RR | RL>;
    <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AL, EL | ER, RL | RR>;
};
```

## mergeRight

Merges this stream and the specified stream together, emitting only the values from the right stream while the left stream runs for its effects.

Source: `effect@4.0.2/src/Stream.ts:4602`.

Vivid `Stream.mergeRight` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mergeRight: {
    <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AR, ER | EL, RR | RL>;
    <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AR, EL | ER, RL | RR>;
};
```

## mergeAll

Merges a collection of streams, running up to the specified number concurrently.

Source: `effect@4.0.2/src/Stream.ts:4728`.

Vivid `Stream.mergeAll` matches: 0. No qualified match. Bare-name matches: 83. Aliased usage is unverified.

```ts
export declare const mergeAll: {
    (options: {
        readonly concurrency: Concurrency;
        readonly bufferSize?: number | undefined;
    }): <A, E, R>(streams: Iterable<Stream<A, E, R>>) => Stream<A, E, R>;
    <A, E, R>(streams: Iterable<Stream<A, E, R>>, options: {
        readonly concurrency: Concurrency;
        readonly bufferSize?: number | undefined;
    }): Stream<A, E, R>;
};
```

## cross

Creates the cartesian product of two streams, running the `right` stream for each element in the `left` stream.

Source: `effect@4.0.2/src/Stream.ts:4859`.

Vivid `Stream.cross` matches: 0. No qualified match. Bare-name matches: 53. Aliased usage is unverified.

```ts
export declare const cross: {
    <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<[
        AL,
        AR
    ], EL | ER, RL | RR>;
    <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<[
        AL,
        AR
    ], EL | ER, RL | RR>;
};
```

## crossWith

Creates a cartesian product of elements from two streams using a function.

Source: `effect@4.0.2/src/Stream.ts:4950`.

Vivid `Stream.crossWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const crossWith: {
    <AR, ER, RR, AL, A>(right: Stream<AR, ER, RR>, f: (left: AL, right: AR) => A): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>;
    <AL, EL, RL, AR, ER, RR, A>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>, f: (left: AL, right: AR) => A): Stream<A, EL | ER, RL | RR>;
};
```

## zipWith

Zips two streams point-wise with a combining function, ending when either stream ends.

Source: `effect@4.0.2/src/Stream.ts:5046`.

Vivid `Stream.zipWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipWith: {
    <AR, ER, RR, AL, A>(right: Stream<AR, ER, RR>, f: (left: AL, right: AR) => A): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>;
    <AL, EL, RL, AR, ER, RR, A>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>, f: (left: AL, right: AR) => A): Stream<A, EL | ER, RL | RR>;
};
```

## zipWithArray

Zips two streams by applying a function to non-empty arrays of elements.

Source: `effect@4.0.2/src/Stream.ts:5160`.

Vivid `Stream.zipWithArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipWithArray: {
    <AR, ER, RR, AL, A>(right: Stream<AR, ER, RR>, f: (left: Arr.NonEmptyReadonlyArray<AL>, right: Arr.NonEmptyReadonlyArray<AR>) => readonly [
        output: Arr.NonEmptyReadonlyArray<A>,
        leftoverLeft: ReadonlyArray<AL>,
        leftoverRight: ReadonlyArray<AR>
    ]): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>;
    <AL, EL, RL, AR, ER, RR, A>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>, f: (left: Arr.NonEmptyReadonlyArray<AL>, right: Arr.NonEmptyReadonlyArray<AR>) => readonly [
        output: Arr.NonEmptyReadonlyArray<A>,
        leftoverLeft: ReadonlyArray<AL>,
        leftoverRight: ReadonlyArray<AR>
    ]): Stream<A, EL | ER, RL | RR>;
};
```

## zip

Zips this stream with another point-wise and emits tuples of elements from both streams. The new stream ends when either stream ends.

Source: `effect@4.0.2/src/Stream.ts:5332`.

Vivid `Stream.zip` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const zip: {
    <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<[
        A,
        A2
    ], E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<[
        A,
        A2
    ], E | E2, R | R2>;
};
```

## zipLeft

Zips this stream with another point-wise and keeps only the values from the left stream.

Source: `effect@4.0.2/src/Stream.ts:5423`.

Vivid `Stream.zipLeft` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipLeft: {
    <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AL, ER | EL, RR | RL>;
    <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AL, EL | ER, RL | RR>;
};
```

## zipRight

Zips this stream with another point-wise, keeping only right values and ending when either stream ends.

Source: `effect@4.0.2/src/Stream.ts:5521`.

Vivid `Stream.zipRight` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipRight: {
    <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AR, ER | EL, RR | RL>;
    <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AR, EL | ER, RL | RR>;
};
```

## zipFlatten

Zips this stream with another point-wise and emits tuples of elements from both streams, flattening the left tuple.

Source: `effect@4.0.2/src/Stream.ts:5618`.

Vivid `Stream.zipFlatten` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipFlatten: {
    <A2, E2, R2>(that: Stream<A2, E2, R2>): <A extends ReadonlyArray<any>, E, R>(self: Stream<A, E, R>) => Stream<[
        ...A,
        A2
    ], E2 | E, R2 | R>;
    <A extends ReadonlyArray<any>, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<[
        ...A,
        A2
    ], E | E2, R | R2>;
};
```

## zipWithIndex

Zips this stream together with the index of elements.

Source: `effect@4.0.2/src/Stream.ts:5716`.

Vivid `Stream.zipWithIndex` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipWithIndex: <A, E, R>(self: Stream<A, E, R>) => Stream<[
    A,
    number
], E, R>;
```

## zipWithNext

Zips each element with the next element, pairing the final element with `Option.none()`.

Source: `effect@4.0.2/src/Stream.ts:5739`.

Vivid `Stream.zipWithNext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipWithNext: <A, E, R>(self: Stream<A, E, R>) => Stream<[
    A,
    Option.Option<A>
], E, R>;
```

## zipWithPrevious

Zips each element with its previous element, starting with `None`.

Source: `effect@4.0.2/src/Stream.ts:5781`.

Vivid `Stream.zipWithPrevious` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipWithPrevious: <A, E, R>(self: Stream<A, E, R>) => Stream<[
    Option.Option<A>,
    A
], E, R>;
```

## zipWithPreviousAndNext

Zips each element with its previous and next values.

Source: `effect@4.0.2/src/Stream.ts:5815`.

Vivid `Stream.zipWithPreviousAndNext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipWithPreviousAndNext: <A, E, R>(self: Stream<A, E, R>) => Stream<[
    Option.Option<A>,
    A,
    Option.Option<A>
], E, R>;
```

## zipLatestAll

Zips multiple streams so that when a value is emitted by any stream, it is combined with the latest values from the other streams to produce a result.

Source: `effect@4.0.2/src/Stream.ts:5884`.

Vivid `Stream.zipLatestAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipLatestAll: <T extends ReadonlyArray<Stream<any, any, any>>>(...streams: T) => Stream<[
    T[number]
] extends [
    never
] ? never : {
    [K in keyof T]: T[K] extends Stream<infer A, infer _E, infer _R> ? A : never;
}, [
    T[number]
] extends [
    never
] ? never : T[number] extends Stream<infer _A, infer _E, infer _R> ? _E : never, [
    T[number]
] extends [
    never
] ? never : T[number] extends Stream<infer _A, infer _E, infer _R> ? _R : never>;
```

## zipLatest

Combines two streams by emitting each new element with the latest value from the other stream.

Source: `effect@4.0.2/src/Stream.ts:5960`.

Vivid `Stream.zipLatest` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipLatest: {
    <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<[
        AL,
        AR
    ], EL | ER, RL | RR>;
    <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<[
        AL,
        AR
    ], EL | ER, RL | RR>;
};
```

## zipLatestWith

Combines the latest values from both streams whenever either emits, using the provided function.

Source: `effect@4.0.2/src/Stream.ts:6077`.

Vivid `Stream.zipLatestWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const zipLatestWith: {
    <AR, ER, RR, AL, A>(right: Stream<AR, ER, RR>, f: (left: AL, right: AR) => A): <EL, RL>(left: Stream<AL, EL, RL>) => Stream<A, EL | ER, RL | RR>;
    <AL, EL, RL, AR, ER, RR, A>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>, f: (left: AL, right: AR) => A): Stream<A, EL | ER, RL | RR>;
};
```

## raceAll

Runs all streams concurrently until one stream emits its first value, then mirrors that winning stream and interrupts the rest.

Source: `effect@4.0.2/src/Stream.ts:6199`.

Vivid `Stream.raceAll` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const raceAll: <S extends ReadonlyArray<Stream<any, any, any>>>(...streams: S) => Stream<Success<S[number]>, Error<S[number]>, Services<S[number]>>;
```

## race

Runs both streams concurrently until one stream emits its first value, then mirrors that winning stream and interrupts the other.

Source: `effect@4.0.2/src/Stream.ts:6260`.

Vivid `Stream.race` matches: 0. No qualified match. Bare-name matches: 32. Aliased usage is unverified.

```ts
export declare const race: {
    <AR, ER, RR>(right: Stream<AR, ER, RR>): <AL, EL, RL>(left: Stream<AL, EL, RL>) => Stream<AL | AR, EL | ER, RL | RR>;
    <AL, EL, RL, AR, ER, RR>(left: Stream<AL, EL, RL>, right: Stream<AR, ER, RR>): Stream<AL | AR, EL | ER, RL | RR>;
};
```

## filter

Filters a stream to the elements that satisfy a predicate.

Source: `effect@4.0.2/src/Stream.ts:6355`.

Vivid `Stream.filter` matches: 20. apps/mobile/src/data/drafts.ts:93, apps/mobile/src/data/drafts.ts:99, apps/server/src/channels/photon.ts:193 Bare-name matches: 621. Aliased usage is unverified.

```ts
export declare const filter: {
    <A, B extends A>(refinement: Refinement<NoInfer<A>, B>): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A>(predicate: Predicate<NoInfer<A>>): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R, B extends A>(self: Stream<A, E, R>, refinement: Refinement<A, B>): Stream<B, E, R>;
    <A, E, R>(self: Stream<A, E, R>, predicate: Predicate<A>): Stream<A, E, R>;
};
```

## filterMap

Filters and maps stream elements in one pass using a `Filter`.

Source: `effect@4.0.2/src/Stream.ts:6480`.

Vivid `Stream.filterMap` matches: 2. apps/server/src/channels/photon.ts:203, apps/server/src/runtime/settlement.ts:160 Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const filterMap: {
    <A, B, X>(filter: Filter.Filter<NoInfer<A>, B, X>): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A, E, R, B, X>(self: Stream<A, E, R>, filter: Filter.Filter<A, B, X>): Stream<B, E, R>;
};
```

## filterEffect

Filters elements in a single pass effectfully.

Source: `effect@4.0.2/src/Stream.ts:6553`.

Vivid `Stream.filterEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterEffect: {
    <A, EX, RX>(predicate: (a: NoInfer<A>, i: number) => Effect.Effect<boolean, EX, RX>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>;
    <A, E, R, EX, RX>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, i: number) => Effect.Effect<boolean, EX, RX>): Stream<A, E | EX, R | RX>;
};
```

## filterMapEffect

Filters and maps elements in one pass effectfully using a `FilterEffect`.

Source: `effect@4.0.2/src/Stream.ts:6632`.

Vivid `Stream.filterMapEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const filterMapEffect: {
    <A, B, X, EX, RX>(filter: Filter.FilterEffect<NoInfer<A>, B, X, EX, RX>): <E, R>(self: Stream<A, E, R>) => Stream<B, E | EX, R | RX>;
    <A, E, R, B, X, EX, RX>(self: Stream<A, E, R>, filter: Filter.FilterEffect<A, B, X, EX, RX>): Stream<B, E | EX, R | RX>;
};
```

## partitionQueue

Partitions a stream using a `Filter` and exposes passing and failing values as scoped queues.

Source: `effect@4.0.2/src/Stream.ts:6719`.

Vivid `Stream.partitionQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const partitionQueue: {
    <A, Pass, Fail>(filter: Filter.Filter<NoInfer<A>, Pass, Fail>, options?: {
        readonly capacity?: number | "unbounded" | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Effect.Effect<[
        passes: Queue.Dequeue<Pass, E | Cause.Done>,
        fails: Queue.Dequeue<Fail, E | Cause.Done>
    ], never, R | Scope.Scope>;
    <A, E, R, Pass, Fail>(self: Stream<A, E, R>, filter: Filter.Filter<NoInfer<A>, Pass, Fail>, options?: {
        readonly capacity?: number | "unbounded" | undefined;
    }): Effect.Effect<[
        passes: Queue.Dequeue<Pass, E | Cause.Done>,
        fails: Queue.Dequeue<Fail, E | Cause.Done>
    ], never, R | Scope.Scope>;
};
```

## partitionEffect

Splits a stream with an effectful `Filter`, returning scoped streams for filter successes and failures.

Source: `effect@4.0.2/src/Stream.ts:7047`.

Vivid `Stream.partitionEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const partitionEffect: {
    <A, Pass, Fail, EX, RX>(filter: Filter.FilterEffect<NoInfer<A>, Pass, Fail, EX, RX>, options?: {
        readonly capacity?: number | "unbounded" | undefined;
        readonly concurrency?: Concurrency | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Effect.Effect<[
        passes: Stream<Pass, E | EX>,
        fails: Stream<Fail, E | EX>
    ], never, R | RX | Scope.Scope>;
    <A, E, R, Pass, Fail, EX, RX>(self: Stream<A, E, R>, filter: Filter.FilterEffect<NoInfer<A>, Pass, Fail, EX, RX>, options?: {
        readonly capacity?: number | "unbounded" | undefined;
        readonly concurrency?: Concurrency | undefined;
    }): Effect.Effect<[
        passes: Stream<Pass, E | EX>,
        fails: Stream<Fail, E | EX>
    ], never, R | RX | Scope.Scope>;
};
```

## partition

Splits a stream into scoped passing and failing substreams using a `Filter`.

Source: `effect@4.0.2/src/Stream.ts:7299`.

Vivid `Stream.partition` matches: 0. No qualified match. Bare-name matches: 367. Aliased usage is unverified.

```ts
export declare const partition: {
    <A, Pass, Fail>(filter: Filter.Filter<NoInfer<A>, Pass, Fail>, options?: {
        readonly capacity?: number | "unbounded" | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Effect.Effect<[
        passes: Stream<Pass, E>,
        fails: Stream<Fail, E>
    ], never, R | Scope.Scope>;
    <A, E, R, Pass, Fail>(self: Stream<A, E, R>, filter: Filter.Filter<NoInfer<A>, Pass, Fail>, options?: {
        readonly capacity?: number | "unbounded" | undefined;
    }): Effect.Effect<[
        passes: Stream<Pass, E>,
        fails: Stream<Fail, E>
    ], never, R | Scope.Scope>;
};
```

## when

Returns the specified stream if the given condition is satisfied, otherwise returns an empty stream.

Source: `effect@4.0.2/src/Stream.ts:7433`.

Vivid `Stream.when` matches: 0. No qualified match. Bare-name matches: 1930. Aliased usage is unverified.

```ts
export declare const when: {
    <EX = never, RX = never>(test: Effect.Effect<boolean, EX, RX>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>;
    <A, E, R, EX = never, RX = never>(self: Stream<A, E, R>, test: Effect.Effect<boolean, EX, RX>): Stream<A, E | EX, R | RX>;
};
```

## peel

Runs a sink to peel off enough elements to produce a value and returns that value with the remaining stream in a scope.

Source: `effect@4.0.2/src/Stream.ts:7522`.

Vivid `Stream.peel` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const peel: {
    <A2, A, E2, R2>(sink: Sink.Sink<A2, A, A, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<[
        A2,
        Stream<A, E, never>
    ], E2 | E, Scope.Scope | R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<A2, A, A, E2, R2>): Effect.Effect<[
        A2,
        Stream<A, E, never>
    ], E | E2, Scope.Scope | R | R2>;
};
```

## buffer

Buffers up to `capacity` elements so a faster producer can progress independently of a slower consumer.

Source: `effect@4.0.2/src/Stream.ts:7645`.

Vivid `Stream.buffer` matches: 1. apps/mobile/src/data/drafts.ts:103 Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const buffer: {
    (options: {
        readonly capacity: "unbounded";
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly capacity: "unbounded";
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
    }): Stream<A, E, R>;
};
```

## bufferArray

Allows a faster producer to progress independently of a slower consumer by buffering up to `capacity` chunks in a queue.

Source: `effect@4.0.2/src/Stream.ts:7760`.

Vivid `Stream.bufferArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const bufferArray: {
    (options: {
        readonly capacity: "unbounded";
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly capacity: "unbounded";
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
    }): Stream<A, E, R>;
};
```

## catchCause

Switches over to the stream produced by the provided function in case this one fails. Allows recovery from all causes of failure, including interruption if the stream is uninterruptible.

Source: `effect@4.0.2/src/Stream.ts:7875`.

Vivid `Stream.catchCause` matches: 0. No qualified match. Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const catchCause: {
    <E, A2, E2, R2>(f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E2, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>): Stream<A | A2, E2, R | R2>;
};
```

## catchDefect

Recovers from defects using the provided function.

Source: `effect@4.0.2/src/Stream.ts:7973`.

Vivid `Stream.catchDefect` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const catchDefect: {
    <A2, E2, R2>(f: (defect: unknown) => Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (defect: unknown) => Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>;
};
```

## tapCause

Runs an effect when the stream fails without changing its values or error, unless the tap effect itself fails.

Source: `effect@4.0.2/src/Stream.ts:8062`.

Vivid `Stream.tapCause` matches: 0. No qualified match. Bare-name matches: 8. Aliased usage is unverified.

```ts
export declare const tapCause: {
    <E, A2, E2, R2>(f: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (cause: Cause.Cause<E>) => Effect.Effect<A2, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## catch

Switches over to the stream produced by the provided function if this one fails.

Source: `effect@4.0.2/src/Stream.ts:8174`.

Vivid `Stream.catch` matches: 0. No qualified match. Bare-name matches: 320. Aliased usage is unverified.

```ts
declare const catch_: {
    <E, A2, E2, R2>(f: (error: E) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E2, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (error: E) => Stream<A2, E2, R2>): Stream<A | A2, E2, R | R2>;
};
export { catch_ as catch };
```

## tapError

Peeks at errors effectfully without changing the stream unless the tap fails.

Source: `effect@4.0.2/src/Stream.ts:8205`.

Vivid `Stream.tapError` matches: 3. apps/mobile/src/data/live.ts:261, packages/client/state/src/live.ts:393, packages/client/state/src/live.ts:471 Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const tapError: {
    <E, A2, E2, R2>(f: (error: E) => Effect.Effect<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, f: (error: E) => Effect.Effect<A2, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## tapErrorTag

Peeks at errors with a matching `_tag` effectfully without changing the stream unless the tap fails.

Source: `effect@4.0.2/src/Stream.ts:8312`.

Vivid `Stream.tapErrorTag` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const tapErrorTag: {
    <const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>, E, A1, E1, R1>(k: K, f: (e: ExtractTag<NoInfer<E>, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect.Effect<A1, E1, R1>): <A, R>(self: Stream<A, E, R>) => Stream<A, E | E1, R1 | R>;
    <A, E, R, const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>, R1, E1, A1>(self: Stream<A, E, R>, k: K, f: (e: ExtractTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect.Effect<A1, E1, R1>): Stream<A, E | E1, R | R1>;
};
```

## tapDefect

Peeks at defects effectfully without changing the stream unless the tap fails.

Source: `effect@4.0.2/src/Stream.ts:8471`.

Vivid `Stream.tapDefect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const tapDefect: {
    <B, E2, R2>(f: (defect: unknown) => Effect.Effect<B, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
    <A, E, R, B, E2, R2>(self: Stream<A, E, R>, f: (defect: unknown) => Effect.Effect<B, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## catchIf

Recovers from errors that match a predicate by switching to a recovery stream.

Source: `effect@4.0.2/src/Stream.ts:8581`.

Vivid `Stream.catchIf` matches: 1. packages/client/state/src/live.ts:171 Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const catchIf: {
    <E, EB extends E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(refinement: Refinement<NoInfer<E>, EB>, f: (e: EB) => Stream<A2, E2, R2>, orElse?: ((e: Exclude<E, EB>) => Stream<A3, E3, R3>) | undefined): <A, R>(self: Stream<A, E, R>) => Stream<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? Exclude<E, EB> : never), R | R2 | R3>;
    <E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(predicate: Predicate<NoInfer<E>>, f: (e: NoInfer<E>) => Stream<A2, E2, R2>, orElse?: ((e: NoInfer<E>) => Stream<A3, E3, R3>) | undefined): <A, R>(self: Stream<A, E, R>) => Stream<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? E : never), R | R2 | R3>;
    <A, E, R, EB extends E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(self: Stream<A, E, R>, refinement: Refinement<E, EB>, f: (e: EB) => Stream<A2, E2, R2>, orElse?: ((e: Exclude<E, EB>) => Stream<A3, E3, R3>) | undefined): Stream<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? Exclude<E, EB> : never), R | R2 | R3>;
    <A, E, R, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(self: Stream<A, E, R>, predicate: Predicate<E>, f: (e: E) => Stream<A2, E2, R2>, orElse?: ((e: E) => Stream<A3, E3, R3>) | undefined): Stream<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? E : never), R | R2 | R3>;
};
```

## catchFilter

Recovers from errors that match a `Filter` by switching to a recovery stream.

Source: `effect@4.0.2/src/Stream.ts:8792`.

Vivid `Stream.catchFilter` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const catchFilter: {
    <E, EB, A2, E2, R2, X, A3 = unassigned, E3 = never, R3 = never>(filter: Filter.Filter<NoInfer<E>, EB, X>, f: (failure: EB) => Stream<A2, E2, R2>, orElse?: ((failure: X) => Stream<A3, E3, R3>) | undefined): <A, R>(self: Stream<A, E, R>) => Stream<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? X : never), R | R2 | R3>;
    <A, E, R, EB, A2, E2, R2, X, A3 = unassigned, E3 = never, R3 = never>(self: Stream<A, E, R>, filter: Filter.Filter<NoInfer<E>, EB, X>, f: (failure: EB) => Stream<A2, E2, R2>, orElse?: ((failure: X) => Stream<A3, E3, R3>) | undefined): Stream<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? X : never), R | R2 | R3>;
};
```

## catchTag

Recovers from failures whose `_tag` matches the provided value by switching to the stream returned by `f`.

Source: `effect@4.0.2/src/Stream.ts:8913`.

Vivid `Stream.catchTag` matches: 0. No qualified match. Bare-name matches: 129. Aliased usage is unverified.

```ts
export declare const catchTag: {
    <const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>, E, A1, E1, R1, A2 = unassigned, E2 = never, R2 = never>(k: K, f: (e: ExtractTag<NoInfer<E>, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A1, E1, R1>, orElse?: ((e: ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A2, E2, R2>) | undefined): <A, R>(self: Stream<A, E, R>) => Stream<A | A1 | Exclude<A2, unassigned>, E1 | E2 | (A2 extends unassigned ? ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K> : never), R | R1 | R2>;
    <A, E, R, const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>, R1, E1, A1, A2 = unassigned, E2 = never, R2 = never>(self: Stream<A, E, R>, k: K, f: (e: ExtractTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A1, E1, R1>, orElse?: ((e: ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Stream<A2, E2, R2>) | undefined): Stream<A | A1 | Exclude<A2, unassigned>, E1 | E2 | (A2 extends unassigned ? ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K> : never), R | R1 | R2>;
};
```

## catchTags

Switches to a recovery stream based on matching `_tag` handlers.

Source: `effect@4.0.2/src/Stream.ts:9099`.

Vivid `Stream.catchTags` matches: 0. No qualified match. Bare-name matches: 65. Aliased usage is unverified.

```ts
export declare const catchTags: {
    <E, Cases extends {
        [K in Extract<E, {
            _tag: string;
        }>["_tag"]]+?: ((error: Extract<E, {
            _tag: K;
        }>) => Stream<any, any, any>);
    } & (unknown extends E ? {} : {
        [K in Exclude<keyof Cases, Extract<E, {
            _tag: string;
        }>["_tag"]>]: never;
    }), A2 = unassigned, E2 = never, R2 = never>(cases: Cases, orElse?: ((e: Exclude<E, {
        _tag: keyof Cases;
    }>) => Stream<A2, E2, R2>) | undefined): <A, R>(self: Stream<A, E, R>) => Stream<A | Exclude<A2, unassigned> | {
        [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<infer A, any, any>) ? A : never;
    }[keyof Cases], E2 | (A2 extends unassigned ? Exclude<E, {
        _tag: keyof Cases;
    }> : never) | {
        [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, infer E, any>) ? E : never;
    }[keyof Cases], R | R2 | {
        [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, any, infer R>) ? R : never;
    }[keyof Cases]>;
    <R, E, A, Cases extends {
        [K in Extract<E, {
            _tag: string;
        }>["_tag"]]+?: ((error: Extract<E, {
            _tag: K;
        }>) => Stream<any, any, any>);
    } & (unknown extends E ? {} : {
        [K in Exclude<keyof Cases, Extract<E, {
            _tag: string;
        }>["_tag"]>]: never;
    }), A2 = unassigned, E2 = never, R2 = never>(self: Stream<A, E, R>, cases: Cases, orElse?: ((e: Exclude<E, {
        _tag: keyof Cases;
    }>) => Stream<A2, E2, R2>) | undefined): Stream<A | Exclude<A2, unassigned> | {
        [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<infer A, any, any>) ? A : never;
    }[keyof Cases], E2 | (A2 extends unassigned ? Exclude<E, {
        _tag: keyof Cases;
    }> : never) | {
        [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, infer E, any>) ? E : never;
    }[keyof Cases], R | R2 | {
        [K in keyof Cases]: Cases[K] extends ((...args: Array<any>) => Stream<any, any, infer R>) ? R : never;
    }[keyof Cases]>;
};
```

## catchReason

Catches a specific reason within a tagged error.

Source: `effect@4.0.2/src/Stream.ts:9300`.

Vivid `Stream.catchReason` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const catchReason: {
    <K extends Tags<E>, E, RK extends ReasonTags<ExtractTag<NoInfer<E>, K>>, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(errorTag: K, reasonTag: RK, f: (reason: ExtractReason<ExtractTag<NoInfer<E>, K>, RK>, error: NarrowReason<ExtractTag<NoInfer<E>, K>, RK>) => Stream<A2, E2, R2>, orElse?: ((reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, RK>, error: OmitReason<ExtractTag<NoInfer<E>, K>, RK>) => Stream<A3, E3, R3>) | undefined): <A, R>(self: Stream<A, E, R>) => Stream<A | A2 | Exclude<A3, unassigned>, ExcludeTag<E, K> | E2 | E3 | (A3 extends unassigned ? ExtractTag<E, K> : never), R | R2 | R3>;
    <A, E, R, K extends Tags<E>, RK extends ReasonTags<ExtractTag<E, K>>, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(self: Stream<A, E, R>, errorTag: K, reasonTag: RK, f: (reason: ExtractReason<ExtractTag<E, K>, RK>, error: NarrowReason<ExtractTag<E, K>, RK>) => Stream<A2, E2, R2>, orElse?: ((reason: ExcludeReason<ExtractTag<E, K>, RK>, error: OmitReason<ExtractTag<E, K>, RK>) => Stream<A3, E3, R3>) | undefined): Stream<A | A2 | Exclude<A3, unassigned>, ExcludeTag<E, K> | E2 | E3 | (A3 extends unassigned ? ExtractTag<E, K> : never), R | R2 | R3>;
};
```

## catchReasons

Catches multiple reasons within a tagged error using an object of handlers.

Source: `effect@4.0.2/src/Stream.ts:9536`.

Vivid `Stream.catchReasons` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const catchReasons: {
    <K extends Tags<E>, E, Cases extends {
        [RK in ReasonTags<ExtractTag<NoInfer<E>, K>>]+?: (reason: ExtractReason<ExtractTag<NoInfer<E>, K>, RK>, error: NarrowReason<ExtractTag<NoInfer<E>, K>, RK>) => Stream<any, any, any>;
    }, A2 = unassigned, E2 = never, R2 = never>(errorTag: K, cases: Cases, orElse?: ((reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>, error: OmitReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>) => Stream<A2, E2, R2>) | undefined): <A, R>(self: Stream<A, E, R>) => Stream<A | Exclude<A2, unassigned> | {
        [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<infer A, any, any> ? A : never;
    }[keyof Cases], ExcludeTag<E, K> | E2 | (A2 extends unassigned ? ExtractTag<E, K> : never) | {
        [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, infer E, any> ? E : never;
    }[keyof Cases], R | R2 | {
        [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, any, infer R> ? R : never;
    }[keyof Cases]>;
    <A, E, R, K extends Tags<E>, Cases extends {
        [RK in ReasonTags<ExtractTag<E, K>>]+?: (reason: ExtractReason<ExtractTag<E, K>, RK>, error: NarrowReason<ExtractTag<E, K>, RK>) => Stream<any, any, any>;
    }, A2 = unassigned, E2 = never, R2 = never>(self: Stream<A, E, R>, errorTag: K, cases: Cases, orElse?: ((reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>, error: OmitReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>) => Stream<A2, E2, R2>) | undefined): Stream<A | Exclude<A2, unassigned> | {
        [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<infer A, any, any> ? A : never;
    }[keyof Cases], ExcludeTag<E, K> | E2 | (A2 extends unassigned ? ExtractTag<E, K> : never) | {
        [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, infer E, any> ? E : never;
    }[keyof Cases], R | R2 | {
        [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Stream<any, any, infer R> ? R : never;
    }[keyof Cases]>;
};
```

## unwrapReason

Promotes nested reason errors into the stream error channel, replacing the parent error.

Source: `effect@4.0.2/src/Stream.ts:9767`.

Vivid `Stream.unwrapReason` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const unwrapReason: {
    <K extends Effect.TagsWithReason<E>, E>(errorTag: K): <A, R>(self: Stream<A, E, R>) => Stream<A, ExcludeTag<E, K> | ReasonOf<ExtractTag<E, K>>, R>;
    <A, E, R, K extends Effect.TagsWithReason<E>>(self: Stream<A, E, R>, errorTag: K): Stream<A, ExcludeTag<E, K> | ReasonOf<ExtractTag<E, K>>, R>;
};
```

## mapError

Transforms the errors emitted by this stream using `f`.

Source: `effect@4.0.2/src/Stream.ts:9913`.

Vivid `Stream.mapError` matches: 3. apps/desktop/src/main/device.ts:106, apps/server/src/computers/boat/shell.ts:181, apps/server/src/computers/boat/transport.ts:253 Bare-name matches: 250. Aliased usage is unverified.

```ts
export declare const mapError: {
    <E, E2>(f: (error: E) => E2): <A, R>(self: Stream<A, E, R>) => Stream<A, E2, R>;
    <A, E, R, E2>(self: Stream<A, E, R>, f: (error: E) => E2): Stream<A, E2, R>;
};
```

## catchCauseIf

Recovers from stream failures by filtering the `Cause` and switching to a recovery stream. Non-matching causes are re-emitted as failures.

Source: `effect@4.0.2/src/Stream.ts:9997`.

Vivid `Stream.catchCauseIf` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const catchCauseIf: {
    <E, A2, E2, R2>(predicate: Predicate<Cause.Cause<E>>, f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, predicate: Predicate<Cause.Cause<E>>, f: (cause: Cause.Cause<E>) => Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>;
};
```

## catchCauseFilter

Recovers from stream failures by filtering the `Cause` and switching to a recovery stream.

Source: `effect@4.0.2/src/Stream.ts:10102`.

Vivid `Stream.catchCauseFilter` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const catchCauseFilter: {
    <E, EB, A2, E2, R2, X extends Cause.Cause<any>>(filter: Filter.Filter<Cause.Cause<E>, EB, X>, f: (failure: EB, cause: Cause.Cause<E>) => Stream<A2, E2, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, Cause.Cause.Error<X> | E2, R2 | R>;
    <A, E, R, EB, A2, E2, R2, X extends Cause.Cause<any>>(self: Stream<A, E, R>, filter: Filter.Filter<Cause.Cause<E>, EB, X>, f: (failure: EB, cause: Cause.Cause<E>) => Stream<A2, E2, R2>): Stream<A | A2, Cause.Cause.Error<X> | E2, R | R2>;
};
```

## orElseIfEmpty

Switches to a fallback stream if this stream is empty.

Source: `effect@4.0.2/src/Stream.ts:10198`.

Vivid `Stream.orElseIfEmpty` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const orElseIfEmpty: {
    <E, A2, E2, R2>(orElse: LazyArg<Stream<A2, E2, R2>>): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, E | E2, R | R2>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, orElse: LazyArg<Stream<A2, E2, R2>>): Stream<A | A2, E | E2, R | R2>;
};
```

## orElseSucceed

Returns a stream that emits a fallback value when this stream fails.

Source: `effect@4.0.2/src/Stream.ts:10280`.

Vivid `Stream.orElseSucceed` matches: 0. No qualified match. Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const orElseSucceed: {
    <E, A2>(f: (error: E) => A2): <A, R>(self: Stream<A, E, R>) => Stream<A | A2, never, R>;
    <A, E, R, A2>(self: Stream<A, E, R>, f: (error: E) => A2): Stream<A | A2, never, R>;
};
```

## orDie

Turns typed failures into defects, making the stream infallible.

Source: `effect@4.0.2/src/Stream.ts:10360`.

Vivid `Stream.orDie` matches: 0. No qualified match. Bare-name matches: 10. Aliased usage is unverified.

```ts
export declare const orDie: <A, E, R>(self: Stream<A, E, R>) => Stream<A, never, R>;
```

## ignore

Ignores failures and ends the stream on error.

Source: `effect@4.0.2/src/Stream.ts:10413`.

Vivid `Stream.ignore` matches: 0. No qualified match. Bare-name matches: 59. Aliased usage is unverified.

```ts
export declare const ignore: <Arg extends Stream<any, any, any> | {
    readonly log?: boolean | Severity | undefined;
} | undefined>(selfOrOptions: Arg, options?: {
    readonly log?: boolean | Severity | undefined;
} | undefined) => [
    Arg
] extends [
    Stream<infer A, infer _E, infer R>
] ? Stream<A, never, R> : <A, E, R>(self: Stream<A, E, R>) => Stream<A, never, R>;
```

## ignoreCause

Ignores the stream's failure cause, including defects, and ends the stream.

Source: `effect@4.0.2/src/Stream.ts:10463`.

Vivid `Stream.ignoreCause` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const ignoreCause: <Arg extends Stream<any, any, any> | {
    readonly log?: boolean | Severity | undefined;
} | undefined>(streamOrOptions: Arg, options?: {
    readonly log?: boolean | Severity | undefined;
} | undefined) => [
    Arg
] extends [
    Stream<infer A, infer _E, infer R>
] ? Stream<A, never, R> : <A, E, R>(self: Stream<A, E, R>) => Stream<A, never, R>;
```

## retry

Retries the stream according to the given schedule when it fails.

Source: `effect@4.0.2/src/Stream.ts:10515`.

Vivid `Stream.retry` matches: 0. No qualified match. Bare-name matches: 148. Aliased usage is unverified.

```ts
export declare const retry: {
    <E, X, E2, R2>(policy: Schedule.Schedule<X, NoInfer<E>, E2, R2> | (($: <SO, SE, SR>(_: Schedule.Schedule<SO, NoInfer<E>, SE, SR>) => Schedule.Schedule<SO, E, SE, SR>) => Schedule.Schedule<X, NoInfer<E>, E2, R2>)): <A, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R2 | R>;
    <A, E, R, X, E2, R2>(self: Stream<A, E, R>, policy: Schedule.Schedule<X, NoInfer<E>, E2, R2> | (($: <SO, SE, SR>(_: Schedule.Schedule<SO, NoInfer<E>, SE, SR>) => Schedule.Schedule<SO, E, SE, SR>) => Schedule.Schedule<X, NoInfer<E>, E2, R2>)): Stream<A, E | E2, R2 | R>;
};
```

## withExecutionPlan

Applies an `ExecutionPlan` to a stream, retrying with step-provided resources until it succeeds or the plan is exhausted.

Source: `effect@4.0.2/src/Stream.ts:10682`.

Vivid `Stream.withExecutionPlan` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withExecutionPlan: {
    <Input, R2, Provides, PolicyE, RX = never>(policy: ExecutionPlan.ExecutionPlan<{
        provides: Provides;
        input: Input;
        error: PolicyE;
        requirements: R2;
    }>, options?: {
        readonly preventFallbackOnPartialStream?: boolean | undefined;
        readonly onEvent?: ((event: ExecutionPlan.Event<Input | PolicyE>) => Effect.Effect<void, never, RX>) | undefined;
    }): <A, E extends Input, R>(self: Stream<A, E, R>) => Stream<A, E | PolicyE, R2 | Exclude<R, Provides> | RX>;
    <A, E extends Input, R, R2, Input, Provides, PolicyE, RX = never>(self: Stream<A, E, R>, policy: ExecutionPlan.ExecutionPlan<{
        provides: Provides;
        input: Input;
        error: PolicyE;
        requirements: R2;
    }>, options?: {
        readonly preventFallbackOnPartialStream?: boolean | undefined;
        readonly onEvent?: ((event: ExecutionPlan.Event<E | PolicyE>) => Effect.Effect<void, never, RX>) | undefined;
    }): Stream<A, E | PolicyE, R2 | Exclude<R, Provides> | RX>;
};
```

## take

Takes the first `n` elements from this stream.

Source: `effect@4.0.2/src/Stream.ts:10980`.

Vivid `Stream.take` matches: 2. apps/server/src/computers/device.test.ts:532, apps/server/src/computers/signins/inject.ts:58 Bare-name matches: 434. Aliased usage is unverified.

```ts
export declare const take: {
    (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>;
};
```

## limitBytes

Emits byte chunks until the configured limit would be exceeded, then drops the crossing chunk and switches to a fallback stream.

Source: `effect@4.0.2/src/Stream.ts:11072`.

Vivid `Stream.limitBytes` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const limitBytes: {
    <E, R>(bytes: ByteSize.Input, onLimitReached: LazyArg<Stream<Uint8Array, E, R>>): (self: Stream<Uint8Array, E, R>) => Stream<Uint8Array, E, R>;
    <E, R>(self: Stream<Uint8Array, E, R>, bytes: ByteSize.Input, onLimitReached: LazyArg<Stream<Uint8Array, E, R>>): Stream<Uint8Array, E, R>;
};
```

## takeRight

Keeps the last `n` elements from this stream.

Source: `effect@4.0.2/src/Stream.ts:11180`.

Vivid `Stream.takeRight` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const takeRight: {
    (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>;
};
```

## takeUntil

Takes elements until the predicate matches.

Source: `effect@4.0.2/src/Stream.ts:11292`.

Vivid `Stream.takeUntil` matches: 1. apps/server/src/observability/export.ts:631 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const takeUntil: {
    <A>(predicate: (a: NoInfer<A>, n: number) => boolean, options?: {
        readonly excludeLast?: boolean | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, predicate: (a: A, n: number) => boolean, options?: {
        readonly excludeLast?: boolean | undefined;
    }): Stream<A, E, R>;
};
```

## takeUntilEffect

Takes stream elements until an effectful predicate returns `true`.

Source: `effect@4.0.2/src/Stream.ts:11427`.

Vivid `Stream.takeUntilEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeUntilEffect: {
    <A, E2, R2>(predicate: (a: NoInfer<A>, n: number) => Effect.Effect<boolean, E2, R2>, options?: {
        readonly excludeLast?: boolean | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, predicate: (a: A, n: number) => Effect.Effect<boolean, E2, R2>, options?: {
        readonly excludeLast?: boolean | undefined;
    }): Stream<A, E | E2, R | R2>;
};
```

## takeWhile

Takes the longest initial prefix of elements that satisfy the predicate.

Source: `effect@4.0.2/src/Stream.ts:11546`.

Vivid `Stream.takeWhile` matches: 4. apps/server/src/auth/dialect.test.ts:167, apps/server/src/library/announcements.test.ts:31, apps/server/src/library/durability.test.ts:133 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const takeWhile: {
    <A, B extends A>(refinement: (a: NoInfer<A>, n: number) => a is B): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A>(predicate: (a: NoInfer<A>, n: number) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R, B extends A>(self: Stream<A, E, R>, refinement: (a: NoInfer<A>, n: number) => a is B): Stream<B, E, R>;
    <A, E, R>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, n: number) => boolean): Stream<A, E, R>;
};
```

## takeWhileFilter

Takes the longest initial prefix accepted by a `Filter` and emits the filter's success values.

Source: `effect@4.0.2/src/Stream.ts:11696`.

Vivid `Stream.takeWhileFilter` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeWhileFilter: {
    <A, B, X>(f: Filter.Filter<NoInfer<A>, B, X>): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A, E, R, B, X>(self: Stream<A, E, R>, f: Filter.Filter<NoInfer<A>, B, X>): Stream<B, E, R>;
};
```

## takeWhileEffect

Takes elements from the stream while the effectful predicate is `true`.

Source: `effect@4.0.2/src/Stream.ts:11797`.

Vivid `Stream.takeWhileEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const takeWhileEffect: {
    <A, E2, R2>(predicate: (a: NoInfer<A>, n: number) => Effect.Effect<boolean, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, n: number) => Effect.Effect<boolean, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## drop

Drops the first `n` elements from this stream.

Source: `effect@4.0.2/src/Stream.ts:11897`.

Vivid `Stream.drop` matches: 1. apps/mobile/src/data/drafts.ts:102 Bare-name matches: 89. Aliased usage is unverified.

```ts
export declare const drop: {
    (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>;
};
```

## dropUntil

Drops elements until the specified predicate evaluates to `true`, then drops that matching element.

Source: `effect@4.0.2/src/Stream.ts:11999`.

Vivid `Stream.dropUntil` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dropUntil: {
    <A>(predicate: (a: NoInfer<A>, index: number) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, index: number) => boolean): Stream<A, E, R>;
};
```

## dropUntilEffect

Drops all elements of the stream until the specified effectful predicate evaluates to `true`.

Source: `effect@4.0.2/src/Stream.ts:12083`.

Vivid `Stream.dropUntilEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dropUntilEffect: {
    <A, E2, R2>(predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## dropWhile

Drops elements from the stream while the specified predicate evaluates to `true`.

Source: `effect@4.0.2/src/Stream.ts:12184`.

Vivid `Stream.dropWhile` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dropWhile: {
    <A>(predicate: (a: NoInfer<A>, index: number) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, predicate: (a: NoInfer<A>, index: number) => boolean): Stream<A, E, R>;
};
```

## dropWhileFilter

Drops elements while the filter succeeds.

Source: `effect@4.0.2/src/Stream.ts:12275`.

Vivid `Stream.dropWhileFilter` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dropWhileFilter: {
    <A, B, X>(filter: Filter.Filter<NoInfer<A>, B, X>): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R, B, X>(self: Stream<A, E, R>, filter: Filter.Filter<NoInfer<A>, B, X>): Stream<A, E, R>;
};
```

## dropWhileEffect

Drops elements while the specified effectful predicate evaluates to `true`.

Source: `effect@4.0.2/src/Stream.ts:12361`.

Vivid `Stream.dropWhileEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dropWhileEffect: {
    <A, E2, R2>(predicate: (a: NoInfer<A>, index: number) => Effect.Effect<boolean, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, predicate: (a: A, index: number) => Effect.Effect<boolean, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## dropRight

Drops the last specified number of elements from this stream.

Source: `effect@4.0.2/src/Stream.ts:12468`.

Vivid `Stream.dropRight` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const dropRight: {
    (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, n: number): Stream<A, E, R>;
};
```

## chunks

Exposes the underlying chunks as a stream of non-empty arrays.

Source: `effect@4.0.2/src/Stream.ts:12601`.

Vivid `Stream.chunks` matches: 0. No qualified match. Bare-name matches: 92. Aliased usage is unverified.

```ts
export declare const chunks: <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
```

## rechunk

Groups the stream into arrays of the specified size, preserving element order.

Source: `effect@4.0.2/src/Stream.ts:12636`.

Vivid `Stream.rechunk` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const rechunk: {
    (size: number): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, size: number): Stream<A, E, R>;
};
```

## sliding

Emits a sliding window of `n` elements.

Source: `effect@4.0.2/src/Stream.ts:12801`.

Vivid `Stream.sliding` matches: 0. No qualified match. Bare-name matches: 17. Aliased usage is unverified.

```ts
export declare const sliding: {
    (chunkSize: number): <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
    <A, E, R>(self: Stream<A, E, R>, chunkSize: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
};
```

## slidingSize

Emits sliding windows of `chunkSize` elements, advancing by `stepSize`.

Source: `effect@4.0.2/src/Stream.ts:12892`.

Vivid `Stream.slidingSize` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const slidingSize: {
    (chunkSize: number, stepSize: number): <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
    <A, E, R>(self: Stream<A, E, R>, chunkSize: number, stepSize: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
};
```

## split

Splits the stream into non-empty groups whenever the predicate matches.

Source: `effect@4.0.2/src/Stream.ts:13056`.

Vivid `Stream.split` matches: 0. No qualified match. Bare-name matches: 131. Aliased usage is unverified.

```ts
export declare const split: {
    <A, B extends A>(refinement: Refinement<NoInfer<A>, B>): <E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<Exclude<A, B>>, E, R>;
    <A>(predicate: Predicate<NoInfer<A>>): <E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
    <A, E, R, B extends A>(self: Stream<A, E, R>, refinement: Refinement<A, B>): Stream<Arr.NonEmptyReadonlyArray<Exclude<A, B>>, E, R>;
    <A, E, R>(self: Stream<A, E, R>, predicate: Predicate<A>): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
};
```

## combine

Combines elements from this stream and the specified stream by repeatedly applying a stateful function that can pull from either side.

Source: `effect@4.0.2/src/Stream.ts:13255`.

Vivid `Stream.combine` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const combine: {
    <A2, E2, R2, S, E, A, A3, E3, R3>(that: Stream<A2, E2, R2>, s: LazyArg<S>, f: (s: S, pullLeft: Pull.Pull<A, E, void>, pullRight: Pull.Pull<A2, E2, void>) => Effect.Effect<readonly [
        A3,
        S
    ], E3, R3>): <R>(self: Stream<A, E, R>) => Stream<A3, E3, R2 | R3 | R>;
    <A, E, R, A2, E2, R2, S, A3, E3, R3>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>, s: LazyArg<S>, f: (s: S, pullLeft: Pull.Pull<A, E, void>, pullRight: Pull.Pull<A2, E2, void>) => Effect.Effect<readonly [
        A3,
        S
    ], E3, R3>): Stream<A3, E3, R | R2 | R3>;
};
```

## combineArray

Combines two streams chunk-by-chunk with a stateful pull function.

Source: `effect@4.0.2/src/Stream.ts:13410`.

Vivid `Stream.combineArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const combineArray: {
    <A2, E2, R2, S, E, A, A3, E3, R3>(that: Stream<A2, E2, R2>, s: LazyArg<S>, f: (s: S, pullLeft: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void>, pullRight: Pull.Pull<Arr.NonEmptyReadonlyArray<A2>, E2, void>) => Effect.Effect<readonly [
        Arr.NonEmptyReadonlyArray<A3>,
        S
    ], E3, R3>): <R>(self: Stream<A, E, R>) => Stream<A3, Pull.ExcludeDone<E3>, R2 | R3 | R>;
    <R, A2, E2, R2, S, E, A, A3, E3, R3>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>, s: LazyArg<S>, f: (s: S, pullLeft: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void>, pullRight: Pull.Pull<Arr.NonEmptyReadonlyArray<A2>, E2, void>) => Effect.Effect<readonly [
        Arr.NonEmptyReadonlyArray<A3>,
        S
    ], E3, R3>): Stream<A3, Pull.ExcludeDone<E3>, R | R2 | R3>;
};
```

## mapAccum

Maps elements statefully, emitting zero or more outputs per input.

Source: `effect@4.0.2/src/Stream.ts:13560`.

Vivid `Stream.mapAccum` matches: 1. apps/server/src/computers/boat/transport.ts:255 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const mapAccum: {
    <S, A, B>(initial: LazyArg<S>, f: (s: S, a: A) => readonly [
        state: S,
        values: ReadonlyArray<B>
    ], options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A, E, R, S, B>(self: Stream<A, E, R>, initial: LazyArg<S>, f: (s: S, a: A) => readonly [
        state: S,
        values: ReadonlyArray<B>
    ], options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): Stream<B, E, R>;
};
```

## mapAccumArray

Maps over non-empty chunk arrays statefully, emitting zero or more values per chunk.

Source: `effect@4.0.2/src/Stream.ts:13718`.

Vivid `Stream.mapAccumArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapAccumArray: {
    <S, A, B>(initial: LazyArg<S>, f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => readonly [
        state: S,
        values: ReadonlyArray<B>
    ], options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<B, E, R>;
    <A, E, R, S, B>(self: Stream<A, E, R>, initial: LazyArg<S>, f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => readonly [
        state: S,
        values: ReadonlyArray<B>
    ], options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): Stream<B, E, R>;
};
```

## mapAccumEffect

Maps each element statefully and effectfully, emitting zero or more output values per input.

Source: `effect@4.0.2/src/Stream.ts:13862`.

Vivid `Stream.mapAccumEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapAccumEffect: {
    <S, A, B, E2, R2>(initial: LazyArg<S>, f: (s: S, a: A) => Effect.Effect<readonly [
        state: S,
        values: ReadonlyArray<B>
    ], E2, R2>, options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>;
    <A, E, R, S, B, E2, R2>(self: Stream<A, E, R>, initial: LazyArg<S>, f: (s: S, a: A) => Effect.Effect<readonly [
        state: S,
        values: ReadonlyArray<B>
    ], E2, R2>, options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): Stream<B, E | E2, R | R2>;
};
```

## mapAccumArrayEffect

Maps each non-empty input chunk statefully and effectfully, emitting zero or more output values per chunk.

Source: `effect@4.0.2/src/Stream.ts:14064`.

Vivid `Stream.mapAccumArrayEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mapAccumArrayEffect: {
    <S, A, B, E2, R2>(initial: LazyArg<S>, f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<readonly [
        state: S,
        values: ReadonlyArray<B>
    ], E2, R2>, options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<B, E | E2, R | R2>;
    <A, E, R, S, B, E2, R2>(self: Stream<A, E, R>, initial: LazyArg<S>, f: (s: S, a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<readonly [
        state: S,
        values: ReadonlyArray<B>
    ], E2, R2>, options?: {
        readonly onHalt?: ((state: S) => ReadonlyArray<B>) | undefined;
    }): Stream<B, E | E2, R | R2>;
};
```

## scan

Accumulates state across the stream, emitting the initial state and each updated state.

Source: `effect@4.0.2/src/Stream.ts:14214`.

Vivid `Stream.scan` matches: 1. apps/server/src/observability/export.ts:627 Bare-name matches: 8. Aliased usage is unverified.

```ts
export declare const scan: {
    <S, A>(initial: LazyArg<S>, f: (s: S, a: A) => S): <E, R>(self: Stream<A, E, R>) => Stream<S, E, R>;
    <A, E, R, S>(self: Stream<A, E, R>, initial: LazyArg<S>, f: (s: S, a: A) => S): Stream<S, E, R>;
};
```

## scanEffect

Accumulates state effectfully and emits the initial state plus each accumulated state.

Source: `effect@4.0.2/src/Stream.ts:14328`.

Vivid `Stream.scanEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const scanEffect: {
    <S, A, E2, R2>(initial: LazyArg<S>, f: (s: S, a: A) => Effect.Effect<S, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<S, E | E2, R | R2>;
    <A, E, R, S, E2, R2>(self: Stream<A, E, R>, initial: LazyArg<S>, f: (s: S, a: A) => Effect.Effect<S, E2, R2>): Stream<S, E | E2, R | R2>;
};
```

## debounce

Drops earlier elements within the debounce window and emits only the latest element after the pause.

Source: `effect@4.0.2/src/Stream.ts:14414`.

Vivid `Stream.debounce` matches: 1. apps/server/src/live/query.ts:65 Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare const debounce: {
    (duration: Duration.Input): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, duration: Duration.Input): Stream<A, E, R>;
};
```

## throttleEffect

Rate-limits stream chunks with an effectful cost function.

Source: `effect@4.0.2/src/Stream.ts:14572`.

Vivid `Stream.throttleEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const throttleEffect: {
    <A, E2, R2>(options: {
        readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<number, E2, R2>;
        readonly units: number;
        readonly duration: Duration.Input;
        readonly burst?: number | undefined;
        readonly strategy?: "enforce" | "shape" | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, options: {
        readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<number, E2, R2>;
        readonly units: number;
        readonly duration: Duration.Input;
        readonly burst?: number | undefined;
        readonly strategy?: "enforce" | "shape" | undefined;
    }): Stream<A, E | E2, R | R2>;
};
```

## throttle

Rate-limits stream chunks with a synchronous cost function.

Source: `effect@4.0.2/src/Stream.ts:14824`.

Vivid `Stream.throttle` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const throttle: {
    <A>(options: {
        readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => number;
        readonly units: number;
        readonly duration: Duration.Input;
        readonly burst?: number | undefined;
        readonly strategy?: "enforce" | "shape" | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly cost: (arr: Arr.NonEmptyReadonlyArray<A>) => number;
        readonly units: number;
        readonly duration: Duration.Input;
        readonly burst?: number | undefined;
        readonly strategy?: "enforce" | "shape" | undefined;
    }): Stream<A, E, R>;
};
```

## grouped

Partitions the stream into non-empty arrays of the specified size.

Source: `effect@4.0.2/src/Stream.ts:14979`.

Vivid `Stream.grouped` matches: 0. No qualified match. Bare-name matches: 33. Aliased usage is unverified.

```ts
export declare const grouped: {
    (n: number): <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
    <A, E, R>(self: Stream<A, E, R>, n: number): Stream<Arr.NonEmptyReadonlyArray<A>, E, R>;
};
```

## groupedWithin

Partitions the stream into arrays, emitting when the chunk size is reached or the duration passes.

Source: `effect@4.0.2/src/Stream.ts:15075`.

Vivid `Stream.groupedWithin` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const groupedWithin: {
    (chunkSize: number, duration: Duration.Input): <A, E, R>(self: Stream<A, E, R>) => Stream<Array<A>, E, R>;
    <A, E, R>(self: Stream<A, E, R>, chunkSize: number, duration: Duration.Input): Stream<Array<A>, E, R>;
};
```

## groupBy

Groups elements into keyed substreams using an effectful classifier.

Source: `effect@4.0.2/src/Stream.ts:15181`.

Vivid `Stream.groupBy` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const groupBy: {
    <A, K, V, E2, R2>(f: (a: NoInfer<A>) => Effect.Effect<readonly [
        K,
        V
    ], E2, R2>, options?: {
        readonly bufferSize?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<readonly [
        K,
        Stream<V>
    ], E | E2, R | R2>;
    <A, E, R, K, V, E2, R2>(self: Stream<A, E, R>, f: (a: NoInfer<A>) => Effect.Effect<readonly [
        K,
        V
    ], E2, R2>, options?: {
        readonly bufferSize?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    }): Stream<readonly [
        K,
        Stream<V>
    ], E | E2, R | R2>;
};
```

## groupByKey

Groups elements by a key and emits a stream per key.

Source: `effect@4.0.2/src/Stream.ts:15315`.

Vivid `Stream.groupByKey` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const groupByKey: {
    <A, K>(f: (a: NoInfer<A>) => K, options?: {
        readonly bufferSize?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Stream<readonly [
        K,
        Stream<A>
    ], E, R>;
    <A, E, R, K>(self: Stream<A, E, R>, f: (a: NoInfer<A>) => K, options?: {
        readonly bufferSize?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    }): Stream<readonly [
        K,
        Stream<A>
    ], E, R>;
};
```

## groupAdjacentBy

Groups consecutive elements that have equal keys into non-empty arrays.

Source: `effect@4.0.2/src/Stream.ts:15558`.

Vivid `Stream.groupAdjacentBy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const groupAdjacentBy: {
    <A, K>(f: (a: NoInfer<A>) => K): <E, R>(self: Stream<A, E, R>) => Stream<readonly [
        K,
        Arr.NonEmptyArray<A>
    ], E, R>;
    <A, E, R, K>(self: Stream<A, E, R>, f: (a: NoInfer<A>) => K): Stream<readonly [
        K,
        Arr.NonEmptyArray<A>
    ], E, R>;
};
```

## transduce

Applies a sink transducer to the stream and emits each sink result.

Source: `effect@4.0.2/src/Stream.ts:15696`.

Vivid `Stream.transduce` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const transduce: {
    <A2, A, E2, R2>(sink: Sink.Sink<A2, A, A, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<A2, A, A, E2, R2>): Stream<A2, E2 | E, R2 | R>;
};
```

## aggregate

Aggregates elements using the provided sink and emits each sink result as a stream element.

Source: `effect@4.0.2/src/Stream.ts:15813`.

Vivid `Stream.aggregate` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export declare const aggregate: {
    <B, A, A2, E2, R2>(sink: Sink.Sink<B, A | A2, A2, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<B, E2 | E, R2 | R>;
    <A, E, R, B, A2, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<B, A | A2, A2, E2, R2>): Stream<B, E | E2, R | R2>;
};
```

## aggregateWithin

Aggregates elements with a sink, emitting each result when the sink completes or the schedule triggers.

Source: `effect@4.0.2/src/Stream.ts:15920`.

Vivid `Stream.aggregateWithin` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const aggregateWithin: {
    <B, A, A2, E2, R2, C, E3, R3>(sink: Sink.Sink<B, A | A2, A2, E2, R2>, schedule: Schedule.Schedule<C, Option.Option<B>, E3, R3>): <E, R>(self: Stream<A, E, R>) => Stream<B, E2 | E | E3, R2 | R3 | R>;
    <A, E, R, B, A2, E2, R2, C, E3, R3>(self: Stream<A, E, R>, sink: Sink.Sink<B, A | A2, A2, E2, R2>, schedule: Schedule.Schedule<C, Option.Option<B>, E3, R3>): Stream<B, E | E2 | E3, R | R2 | R3>;
};
```

## broadcastN

Creates a fixed-size tuple of streams that each emit the same elements as the source stream.

Source: `effect@4.0.2/src/Stream.ts:16255`.

Vivid `Stream.broadcastN` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const broadcastN: {
    <const N extends number>(options: {
        readonly n: N;
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
    } | {
        readonly n: N;
        readonly capacity: number;
        readonly strategy?: "sliding" | "dropping" | "suspend" | undefined;
        readonly replay?: number | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<TupleOf<N, Stream<A, E>>, never, Scope.Scope | R>;
    <A, E, R, const N extends number>(self: Stream<A, E, R>, options: {
        readonly n: N;
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
    } | {
        readonly capacity: number;
        readonly n: N;
        readonly strategy?: "sliding" | "dropping" | "suspend" | undefined;
        readonly replay?: number | undefined;
    }): Effect.Effect<TupleOf<N, Stream<A, E>>, never, Scope.Scope | R>;
};
```

## broadcast

Creates a PubSub-backed stream that multicasts the source to all subscribers.

Source: `effect@4.0.2/src/Stream.ts:16494`.

Vivid `Stream.broadcast` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const broadcast: {
    (options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "sliding" | "dropping" | "suspend" | undefined;
        readonly replay?: number | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Stream<A, E>, never, Scope.Scope | R>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "sliding" | "dropping" | "suspend" | undefined;
        readonly replay?: number | undefined;
    }): Effect.Effect<Stream<A, E>, never, Scope.Scope | R>;
};
```

## share

Returns a new Stream that multicasts the original stream, subscribing when the first consumer starts.

Source: `effect@4.0.2/src/Stream.ts:16646`.

Vivid `Stream.share` matches: 0. No qualified match. Bare-name matches: 218. Aliased usage is unverified.

```ts
export declare const share: {
    (options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "sliding" | "dropping" | "suspend" | undefined;
        readonly replay?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Stream<A, E>, never, Scope.Scope | R>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "sliding" | "dropping" | "suspend" | undefined;
        readonly replay?: number | undefined;
        readonly idleTimeToLive?: Duration.Input | undefined;
    }): Effect.Effect<Stream<A, E>, never, Scope.Scope | R>;
};
```

## pipeThroughChannel

Pipes this stream through a channel that consumes and emits chunked elements.

Source: `effect@4.0.2/src/Stream.ts:16824`.

Vivid `Stream.pipeThroughChannel` matches: 1. apps/server/src/http/upload.ts:101 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const pipeThroughChannel: {
    <R2, E, E2, A, A2>(channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>): <R>(self: Stream<A, E, R>) => Stream<A2, E2, R2 | R>;
    <R, R2, E, E2, A, A2>(self: Stream<A, E, R>, channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>): Stream<A2, E2, R | R2>;
};
```

## pipeThroughChannelOrFail

Pipes values through the provided channel while preserving this stream's failures alongside any channel failures.

Source: `effect@4.0.2/src/Stream.ts:16942`.

Vivid `Stream.pipeThroughChannelOrFail` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const pipeThroughChannelOrFail: {
    <R2, E, E2, A, A2>(channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>): <R>(self: Stream<A, E, R>) => Stream<A2, E | E2, R2 | R>;
    <R, R2, E, E2, A, A2>(self: Stream<A, E, R>, channel: Channel.Channel<Arr.NonEmptyReadonlyArray<A2>, E2, unknown, Arr.NonEmptyReadonlyArray<A>, E, unknown, R2>): Stream<A2, E | E2, R | R2>;
};
```

## pipeThrough

Pipes the stream through `Sink.toChannel`, emitting only the sink leftovers.

Source: `effect@4.0.2/src/Stream.ts:17053`.

Vivid `Stream.pipeThrough` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const pipeThrough: {
    <A2, A, L, E2, R2>(sink: Sink.Sink<A2, A, L, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<L, E2 | E, R2 | R>;
    <A, E, R, A2, L, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<A2, A, L, E2, R2>): Stream<L, E | E2, R | R2>;
};
```

## collect

Collects all elements into an array and emits it as a single element.

Source: `effect@4.0.2/src/Stream.ts:17144`.

Vivid `Stream.collect` matches: 0. No qualified match. Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const collect: <A, E, R>(self: Stream<A, E, R>) => Stream<Array<A>, E, R>;
```

## accumulate

Accumulates elements into a growing array, emitting the cumulative array for each input chunk.

Source: `effect@4.0.2/src/Stream.ts:17171`.

Vivid `Stream.accumulate` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const accumulate: <A, E, R>(self: Stream<A, E, R>) => Stream<Arr.NonEmptyArray<A>, E, R>;
```

## changes

Emits only elements that differ from the previous one.

Source: `effect@4.0.2/src/Stream.ts:17201`.

Vivid `Stream.changes` matches: 5. apps/mobile/src/data/drafts.ts:101, apps/server/src/live/query.ts:67, apps/server/src/live/query.ts:91 Bare-name matches: 565. Aliased usage is unverified.

```ts
export declare const changes: <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
```

## changesWith

Returns a stream that only emits elements that are not equal to the previously emitted element, as determined by the specified predicate.

Source: `effect@4.0.2/src/Stream.ts:17227`.

Vivid `Stream.changesWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const changesWith: {
    <A>(f: (x: A, y: A) => boolean): <E, R>(self: Stream<A, E, R>) => Stream<A, E, R>;
    <A, E, R>(self: Stream<A, E, R>, f: (x: A, y: A) => boolean): Stream<A, E, R>;
};
```

## changesWithEffect

Emits only elements that differ from the previous element, using an effectful equality check.

Source: `effect@4.0.2/src/Stream.ts:17332`.

Vivid `Stream.changesWithEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const changesWithEffect: {
    <A, E2, R2>(f: (x: A, y: A) => Effect.Effect<boolean, E2, R2>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | E2, R | R2>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, f: (x: A, y: A) => Effect.Effect<boolean, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## decodeText

Decodes Uint8Array chunks into strings using TextDecoder with an optional encoding.

Source: `effect@4.0.2/src/Stream.ts:17455`.

Vivid `Stream.decodeText` matches: 5. apps/server/src/computers/boat/transport.ts:254, apps/server/src/library/extraction/process.ts:518, apps/server/src/library/fixtures/process/command.ts:93 Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const decodeText: <Arg extends Stream<Uint8Array, any, any> | {
    readonly encoding?: string | undefined;
} | undefined = {
    readonly encoding?: string | undefined;
}>(streamOrOptions?: Arg, options?: {
    readonly encoding?: string | undefined;
} | undefined) => [
    Arg
] extends [
    Stream<Uint8Array, infer _E, infer _R>
] ? Stream<string, _E, _R> : <E, R>(self: Stream<Uint8Array, E, R>) => Stream<string, E, R>;
```

## encodeText

Encodes a stream of strings into UTF-8 `Uint8Array` chunks.

Source: `effect@4.0.2/src/Stream.ts:17501`.

Vivid `Stream.encodeText` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const encodeText: <E, R>(self: Stream<string, E, R>) => Stream<Uint8Array, E, R>;
```

## splitLines

Splits a stream of strings into lines, handling `\n`, `\r`, and `\r\n` delimiters across chunks.

Source: `effect@4.0.2/src/Stream.ts:17527`.

Vivid `Stream.splitLines` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const splitLines: <E, R>(self: Stream<string, E, R>) => Stream<string, E, R>;
```

## intersperse

Inserts the provided element between emitted elements.

Source: `effect@4.0.2/src/Stream.ts:17554`.

Vivid `Stream.intersperse` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const intersperse: {
    <A2>(element: A2): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A, E, R>;
    <A, E, R, A2>(self: Stream<A, E, R>, element: A2): Stream<A | A2, E, R>;
};
```

## intersperseAffixes

Adds a start value, middle value, and end value around stream elements.

Source: `effect@4.0.2/src/Stream.ts:17641`.

Vivid `Stream.intersperseAffixes` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const intersperseAffixes: {
    <A2, A3, A4>(options: {
        readonly start: A2;
        readonly middle: A3;
        readonly end: A4;
    }): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A3 | A4 | A, E, R>;
    <A, E, R, A2, A3, A4>(self: Stream<A, E, R>, options: {
        readonly start: A2;
        readonly middle: A3;
        readonly end: A4;
    }): Stream<A | A2 | A3 | A4, E, R>;
};
```

## interleave

Interleaves this stream with the specified stream by alternating pulls from each stream; when one ends, the remaining values from the other stream are emitted.

Source: `effect@4.0.2/src/Stream.ts:17739`.

Vivid `Stream.interleave` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interleave: {
    <A2, E2, R2>(that: Stream<A2, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A, E2 | E, R2 | R>;
    <A, E, R, A2, E2, R2>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>): Stream<A | A2, E | E2, R | R2>;
};
```

## interleaveWith

Interleaves two streams deterministically by following a boolean decider stream.

Source: `effect@4.0.2/src/Stream.ts:17838`.

Vivid `Stream.interleaveWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interleaveWith: {
    <A2, E2, R2, E3, R3>(that: Stream<A2, E2, R2>, decider: Stream<boolean, E3, R3>): <A, E, R>(self: Stream<A, E, R>) => Stream<A2 | A, E2 | E3 | E, R2 | R3 | R>;
    <A, E, R, A2, E2, R2, E3, R3>(self: Stream<A, E, R>, that: Stream<A2, E2, R2>, decider: Stream<boolean, E3, R3>): Stream<A | A2, E | E2 | E3, R | R2 | R3>;
};
```

## interruptWhen

Interrupts the evaluation of this stream when the provided effect completes. The given effect will be forked as part of this stream, and its success will be discarded. This combinator will also interrupt any in-progress element being pulled from upstream.

Source: `effect@4.0.2/src/Stream.ts:18056`.

Vivid `Stream.interruptWhen` matches: 4. apps/server/src/computers/device.ts:504, apps/server/src/computers/handlers.ts:159, apps/server/src/live/query.ts:125 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const interruptWhen: {
    <X, E2, R2>(effect: Effect.Effect<X, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## haltWhen

Stops a stream after the current pull when an effect completes.

Source: `effect@4.0.2/src/Stream.ts:18182`.

Vivid `Stream.haltWhen` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const haltWhen: {
    <X, E2, R2>(effect: Effect.Effect<X, E2, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E2 | E, R2 | R>;
    <A, E, R, X, E2, R2>(self: Stream<A, E, R>, effect: Effect.Effect<X, E2, R2>): Stream<A, E | E2, R | R2>;
};
```

## onExit

Runs the provided finalizer when the stream exits, passing the exit value.

Source: `effect@4.0.2/src/Stream.ts:18300`.

Vivid `Stream.onExit` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const onExit: {
    <E, R2>(finalizer: (exit: Exit.Exit<unknown, E>) => Effect.Effect<unknown, never, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>;
    <A, E, R, R2>(self: Stream<A, E, R>, finalizer: (exit: Exit.Exit<unknown, E>) => Effect.Effect<unknown, never, R2>): Stream<A, E, R | R2>;
};
```

## onError

Runs the provided effect when the stream fails, passing the failure cause.

Source: `effect@4.0.2/src/Stream.ts:18398`.

Vivid `Stream.onError` matches: 0. No qualified match. Bare-name matches: 26. Aliased usage is unverified.

```ts
export declare const onError: {
    <E, X, R2>(cleanup: (cause: Cause.Cause<E>) => Effect.Effect<X, never, R2>): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R2 | R>;
    <A, E, R, X, R2>(self: Stream<A, E, R>, cleanup: (cause: Cause.Cause<E>) => Effect.Effect<X, never, R2>): Stream<A, E, R | R2>;
};
```

## onStart

Runs the provided effect before this stream starts.

Source: `effect@4.0.2/src/Stream.ts:18497`.

Vivid `Stream.onStart` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const onStart: {
    <X, EX, RX>(onStart: Effect.Effect<X, EX, RX>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>;
    <A, E, R, X, EX, RX>(self: Stream<A, E, R>, onStart: Effect.Effect<X, EX, RX>): Stream<A, E | EX, R | RX>;
};
```

## onFirst

Runs the provided effect with the first element emitted by the stream.

Source: `effect@4.0.2/src/Stream.ts:18579`.

Vivid `Stream.onFirst` matches: 0. No qualified match. Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const onFirst: {
    <A, X, EX, RX>(onFirst: (element: NoInfer<A>) => Effect.Effect<X, EX, RX>): <E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>;
    <A, E, R, X, EX, RX>(self: Stream<A, E, R>, onFirst: (element: NoInfer<A>) => Effect.Effect<X, EX, RX>): Stream<A, E | EX, R | RX>;
};
```

## onEnd

Runs the provided effect when the stream ends successfully.

Source: `effect@4.0.2/src/Stream.ts:18659`.

Vivid `Stream.onEnd` matches: 0. No qualified match. Bare-name matches: 7. Aliased usage is unverified.

```ts
export declare const onEnd: {
    <X, EX, RX>(onEnd: Effect.Effect<X, EX, RX>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | EX, R | RX>;
    <A, E, R, X, EX, RX>(self: Stream<A, E, R>, onEnd: Effect.Effect<X, EX, RX>): Stream<A, E | EX, R | RX>;
};
```

## ensuring

Executes the provided finalizer after this stream's finalizers run.

Source: `effect@4.0.2/src/Stream.ts:18743`.

Vivid `Stream.ensuring` matches: 3. apps/server/src/connections/transport.test.ts:1443, apps/server/src/observability/export.test.ts:1224, apps/server/src/push/adapter.test.ts:75 Bare-name matches: 39. Aliased usage is unverified.

```ts
export declare const ensuring: {
    <R2>(finalizer: Effect.Effect<unknown, never, R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R | R2>;
    <A, E, R, R2>(self: Stream<A, E, R>, finalizer: Effect.Effect<unknown, never, R2>): Stream<A, E, R | R2>;
};
```

## provide

Provides a layer or context to the stream, removing the corresponding service requirements. Use `options.local` to build the layer every time; by default, layers are shared between provide calls.

Source: `effect@4.0.2/src/Stream.ts:18834`.

Vivid `Stream.provide` matches: 0. No qualified match. Bare-name matches: 483. Aliased usage is unverified.

```ts
export declare const provide: {
    <AL, EL = never, RL = never>(layer: Layer.Layer<AL, EL, RL> | Context.Context<AL>, options?: {
        readonly local?: boolean | undefined;
    } | undefined): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | EL, Exclude<R, AL> | RL>;
    <A, E, R, AL, EL = never, RL = never>(self: Stream<A, E, R>, layer: Layer.Layer<AL, EL, RL> | Context.Context<AL>, options?: {
        readonly local?: boolean | undefined;
    } | undefined): Stream<A, E | EL, Exclude<R, AL> | RL>;
};
```

## provideContext

Provides multiple services to the stream using a context.

Source: `effect@4.0.2/src/Stream.ts:18953`.

Vivid `Stream.provideContext` matches: 1. apps/server/src/threads/gateway.ts:285 Bare-name matches: 44. Aliased usage is unverified.

```ts
export declare const provideContext: {
    <R2>(context: Context.Context<R2>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, R2>>;
    <A, E, R, R2>(self: Stream<A, E, R>, context: Context.Context<R2>): Stream<A, E, Exclude<R, R2>>;
};
```

## provideService

Provides the stream with a single required service, eliminating that requirement from its environment.

Source: `effect@4.0.2/src/Stream.ts:19069`.

Vivid `Stream.provideService` matches: 0. No qualified match. Bare-name matches: 417. Aliased usage is unverified.

```ts
export declare const provideService: {
    <I, S>(key: Context.Key<I, S>, service: NoInfer<S>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, I>>;
    <A, E, R, I, S>(self: Stream<A, E, R>, key: Context.Key<I, S>, service: NoInfer<S>): Stream<A, E, Exclude<R, I>>;
};
```

## provideServiceEffect

Provides a service to the stream using an effect, removing the requirement and adding the effect's error and environment.

Source: `effect@4.0.2/src/Stream.ts:19189`.

Vivid `Stream.provideServiceEffect` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const provideServiceEffect: {
    <I, S, ES, RS>(key: Context.Key<I, S>, service: Effect.Effect<NoInfer<S>, ES, RS>): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E | ES, Exclude<R, I> | RS>;
    <A, E, R, I, S, ES, RS>(self: Stream<A, E, R>, key: Context.Key<I, S>, service: Effect.Effect<NoInfer<S>, ES, RS>): Stream<A, E | ES, Exclude<R, I> | RS>;
};
```

## updateContext

Transforms the stream's required services by mapping the current context to a new one.

Source: `effect@4.0.2/src/Stream.ts:19314`.

Vivid `Stream.updateContext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const updateContext: {
    <R, R2>(f: (context: Context.Context<R2>) => Context.Context<R>): <A, E>(self: Stream<A, E, R>) => Stream<A, E, R2>;
    <A, E, R, R2>(self: Stream<A, E, R>, f: (context: Context.Context<R2>) => Context.Context<R>): Stream<A, E, R2>;
};
```

## updateService

Updates a single service in the stream environment by applying a function.

Source: `effect@4.0.2/src/Stream.ts:19433`.

Vivid `Stream.updateService` matches: 0. No qualified match. Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const updateService: {
    <I, S>(key: Context.Key<I, S>, f: (service: NoInfer<S>) => S): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, R | I>;
    <A, E, R, I, S>(self: Stream<A, E, R>, key: Context.Key<I, S>, f: (service: NoInfer<S>) => S): Stream<A, E, R | I>;
};
```

## withSpan

Wraps the stream with a new span for tracing.

Source: `effect@4.0.2/src/Stream.ts:19528`.

Vivid `Stream.withSpan` matches: 0. No qualified match. Bare-name matches: 45. Aliased usage is unverified.

```ts
export declare const withSpan: {
    (name: string, options?: SpanOptions): <A, E, R>(self: Stream<A, E, R>) => Stream<A, E, Exclude<R, ParentSpan>>;
    <A, E, R>(self: Stream<A, E, R>, name: string, options?: SpanOptions): Stream<A, E, Exclude<R, ParentSpan>>;
};
```

## Do

Provides the entry point for do-notation style stream composition.

Source: `effect@4.0.2/src/Stream.ts:19612`.

Vivid `Stream.Do` matches: 0. No qualified match. Bare-name matches: 66. Aliased usage is unverified.

```ts
export declare const Do: Stream<{}>;
```

## let

Adds a computed field to the current Do-notation record.

Source: `effect@4.0.2/src/Stream.ts:19655`.

Vivid `Stream.let` matches: 0. No qualified match. Bare-name matches: 573. Aliased usage is unverified.

```ts
declare const let_: {
    <N extends string, A extends Record<string, any>, B>(name: N, f: (a: NoInfer<A>) => B): <E, R>(self: Stream<A, E, R>) => Stream<Simplify<Omit<A, N> & Record<N, B>>, E, R>;
    <A extends Record<string, any>, E, R, B, N extends string>(self: Stream<A, E, R>, name: N, f: (a: NoInfer<A>) => B): Stream<Simplify<Omit<A, N> & Record<N, B>>, E, R>;
};
export { let_ as let };
```

## bind

Binds the result of a stream to a field in the do-notation record.

Source: `effect@4.0.2/src/Stream.ts:19680`.

Vivid `Stream.bind` matches: 0. No qualified match. Bare-name matches: 83. Aliased usage is unverified.

```ts
export declare const bind: {
    <N extends string, A extends Record<string, any>, B, E2, R2>(name: N, f: (a: NoInfer<A>) => Stream<B, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
    } | undefined): <E, R>(self: Stream<A, E, R>) => Stream<Simplify<Omit<A, N> & Record<N, B>>, E2 | E, R2 | R>;
    <A extends Record<string, any>, E, R, B, E2, R2, N extends string>(self: Stream<A, E, R>, name: N, f: (a: NoInfer<A>) => Stream<B, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
    } | undefined): Stream<Simplify<Omit<A, N> & Record<N, B>>, E | E2, R | R2>;
};
```

## bindEffect

Binds an Effect-produced value into the do-notation record for each stream element.

Source: `effect@4.0.2/src/Stream.ts:19778`.

Vivid `Stream.bindEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const bindEffect: {
    <N extends string, A extends Record<string, any>, B, E2, R2>(name: N, f: (a: NoInfer<A>) => Effect.Effect<B, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
        readonly unordered?: boolean | undefined;
    } | undefined): <E, R>(self: Stream<A, E, R>) => Stream<Simplify<Omit<A, N> & Record<N, B>>, E | E2, R | R2>;
    <A extends Record<string, any>, E, R, B, E2, R2, N extends string>(self: Stream<A, E, R>, name: N, f: (a: NoInfer<A>) => Effect.Effect<B, E2, R2>, options?: {
        readonly concurrency?: Concurrency | undefined;
        readonly bufferSize?: number | undefined;
        readonly unordered?: boolean | undefined;
    } | undefined): Stream<Simplify<Omit<A, N> & Record<N, B>>, E | E2, R | R2>;
};
```

## bindTo

Maps each element into a record keyed by the provided name.

Source: `effect@4.0.2/src/Stream.ts:19877`.

Vivid `Stream.bindTo` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const bindTo: {
    <N extends string>(name: N): <A, E, R>(self: Stream<A, E, R>) => Stream<{
        [K in N]: A;
    }, E, R>;
    <A, E, R, N extends string>(self: Stream<A, E, R>, name: N): Stream<{
        [K in N]: A;
    }, E, R>;
};
```

## run

Runs a stream with a sink and returns the sink result.

Source: `effect@4.0.2/src/Stream.ts:19936`.

Vivid `Stream.run` matches: 0. No qualified match. Bare-name matches: 1579. Aliased usage is unverified.

```ts
export declare const run: {
    <A2, A, L, E2, R2>(sink: Sink.Sink<A2, A, L, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<A2, E2 | E, R | R2>;
    <A, E, R, L, A2, E2, R2>(self: Stream<A, E, R>, sink: Sink.Sink<A2, A, L, E2, R2>): Effect.Effect<A2, E | E2, R | R2>;
};
```

## runCollect

Runs the stream and collects all elements into an array.

Source: `effect@4.0.2/src/Stream.ts:20006`.

Vivid `Stream.runCollect` matches: 4. apps/server/src/auth/dialect.test.ts:169, apps/server/src/library/announcements.test.ts:33, apps/server/src/library/durability.test.ts:135 Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const runCollect: <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Array<A>, E, R>;
```

## runCount

Runs the stream and returns the number of elements emitted.

Source: `effect@4.0.2/src/Stream.ts:20040`.

Vivid `Stream.runCount` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runCount: <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<number, E, R>;
```

## runSum

Runs the stream and returns the numeric sum of its elements.

Source: `effect@4.0.2/src/Stream.ts:20063`.

Vivid `Stream.runSum` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runSum: <E, R>(self: Stream<number, E, R>) => Effect.Effect<number, E, R>;
```

## runFold

Runs the stream and folds elements using a pure reducer.

Source: `effect@4.0.2/src/Stream.ts:20095`.

Vivid `Stream.runFold` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runFold: {
    <Z, A>(initial: LazyArg<Z>, f: (acc: Z, a: A) => Z): <E, R>(self: Stream<A, E, R>) => Effect.Effect<Z, E, R>;
    <A, E, R, Z>(self: Stream<A, E, R>, initial: LazyArg<Z>, f: (acc: Z, a: A) => Z): Effect.Effect<Z, E, R>;
};
```

## runFoldEffect

Runs the stream and folds elements using an effectful reducer.

Source: `effect@4.0.2/src/Stream.ts:20189`.

Vivid `Stream.runFoldEffect` matches: 1. apps/server/src/watches/receiver.ts:95 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const runFoldEffect: {
    <Z, A, EX, RX>(initial: LazyArg<Z>, f: (acc: Z, a: A) => Effect.Effect<Z, EX, RX>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<Z, E | EX, R | RX>;
    <A, E, R, Z, EX, RX>(self: Stream<A, E, R>, initial: LazyArg<Z>, f: (acc: Z, a: A) => Effect.Effect<Z, EX, RX>): Effect.Effect<Z, E | EX, R | RX>;
};
```

## runHead

Runs the stream and returns the first element as an `Option`.

Source: `effect@4.0.2/src/Stream.ts:20297`.

Vivid `Stream.runHead` matches: 33. apps/server/src/auth/dialect.test.ts:198, apps/server/src/companies/announcements.test.ts:152, apps/server/src/computers/egress/address.live.test.ts:103 Bare-name matches: 34. Aliased usage is unverified.

```ts
export declare const runHead: <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
```

## runLast

Runs the stream and returns the last element as an `Option`.

Source: `effect@4.0.2/src/Stream.ts:20325`.

Vivid `Stream.runLast` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runLast: <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
```

## runForEach

Runs the provided effectful callback for each element of the stream.

Source: `effect@4.0.2/src/Stream.ts:20351`.

Vivid `Stream.runForEach` matches: 19. apps/desktop/src/main/device.ts:289, apps/desktop/src/main/device.ts:295, apps/mobile/src/data/connecting.ts:319 Bare-name matches: 19. Aliased usage is unverified.

```ts
export declare const runForEach: {
    <A, X, E2, R2>(f: (a: A) => Effect.Effect<X, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E2 | E, R2 | R>;
    <A, E, R, X, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<X, E2, R2>): Effect.Effect<void, E | E2, R | R2>;
};
```

## runForEachWhile

Runs the stream, applying the effectful predicate to each element and stopping when it returns `false`.

Source: `effect@4.0.2/src/Stream.ts:20442`.

Vivid `Stream.runForEachWhile` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runForEachWhile: {
    <A, E2, R2>(f: (a: A) => Effect.Effect<boolean, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E2 | E, R2 | R>;
    <A, E, R, E2, R2>(self: Stream<A, E, R>, f: (a: A) => Effect.Effect<boolean, E2, R2>): Effect.Effect<void, E | E2, R | R2>;
};
```

## runForEachArray

Consumes the stream in chunks, passing each non-empty array to the callback.

Source: `effect@4.0.2/src/Stream.ts:20548`.

Vivid `Stream.runForEachArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runForEachArray: {
    <A, X, E2, R2>(f: (a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<X, E2, R2>): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E2 | E, R2 | R>;
    <A, E, R, X, E2, R2>(self: Stream<A, E, R>, f: (a: Arr.NonEmptyReadonlyArray<A>) => Effect.Effect<X, E2, R2>): Effect.Effect<void, E | E2, R | R2>;
};
```

## runDrain

Runs the stream for its effects, discarding emitted elements.

Source: `effect@4.0.2/src/Stream.ts:20634`.

Vivid `Stream.runDrain` matches: 9. apps/server/src/computers/device.test.ts:488, apps/server/src/computers/device.test.ts:509, apps/server/src/computers/device.test.ts:532 Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const runDrain: <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E, R>;
```

## toPull

Returns a scoped pull for manually consuming the stream's output chunks.

Source: `effect@4.0.2/src/Stream.ts:20666`.

Vivid `Stream.toPull` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toPull: <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E>, never, R | Scope.Scope>;
```

## mkString

Concatenates all emitted strings into a single string.

Source: `effect@4.0.2/src/Stream.ts:20691`.

Vivid `Stream.mkString` matches: 5. apps/server/src/computers/signins/inject.ts:59, apps/server/src/library/extraction/process.ts:518, apps/server/src/library/fixtures/process/command.ts:92 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const mkString: <E, R>(self: Stream<string, E, R>) => Effect.Effect<string, E, R>;
```

## mkArrayBuffer

Concatenates the stream's `Uint8Array` chunks into a single `ArrayBuffer`.

Source: `effect@4.0.2/src/Stream.ts:20726`.

Vivid `Stream.mkArrayBuffer` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mkArrayBuffer: <E, R>(self: Stream<Uint8Array, E, R>) => Effect.Effect<ArrayBuffer, E, R>;
```

## mkUint8Array

Concatenates the stream's `Uint8Array` chunks into a single `Uint8Array`.

Source: `effect@4.0.2/src/Stream.ts:20755`.

Vivid `Stream.mkUint8Array` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const mkUint8Array: <E, R>(self: Stream<Uint8Array, E, R>) => Effect.Effect<Uint8Array, E, R>;
```

## toReadableStreamWith

Converts the stream to a `ReadableStream` using the provided services.

Source: `effect@4.0.2/src/Stream.ts:20785`.

Vivid `Stream.toReadableStreamWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toReadableStreamWith: {
    <A, XR>(context: Context.Context<XR>, options?: {
        readonly strategy?: QueuingStrategy<A> | undefined;
    }): <E, R extends XR>(self: Stream<A, E, R>) => ReadableStream<A>;
    <A, E, XR, R extends XR>(self: Stream<A, E, R>, context: Context.Context<XR>, options?: {
        readonly strategy?: QueuingStrategy<A> | undefined;
    }): ReadableStream<A>;
};
```

## toReadableStream

Converts a stream to a `ReadableStream`.

Source: `effect@4.0.2/src/Stream.ts:20917`.

Vivid `Stream.toReadableStream` matches: 1. apps/desktop/src/main/proxy.ts:51 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const toReadableStream: {
    <A>(options?: {
        readonly strategy?: QueuingStrategy<A> | undefined;
    }): <E>(self: Stream<A, E>) => ReadableStream<A>;
    <A, E>(self: Stream<A, E>, options?: {
        readonly strategy?: QueuingStrategy<A> | undefined;
    }): ReadableStream<A>;
};
```

## toReadableStreamEffect

Creates an Effect that builds a ReadableStream from the stream.

Source: `effect@4.0.2/src/Stream.ts:21006`.

Vivid `Stream.toReadableStreamEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toReadableStreamEffect: {
    <A>(options?: {
        readonly strategy?: QueuingStrategy<A> | undefined;
    }): <E, R>(self: Stream<A, E, R>) => Effect.Effect<ReadableStream<A>, never, R>;
    <A, E, R>(self: Stream<A, E, R>, options?: {
        readonly strategy?: QueuingStrategy<A> | undefined;
    }): Effect.Effect<ReadableStream<A>, never, R>;
};
```

## toAsyncIterableWith

Converts the stream to an `AsyncIterable` using the provided services.

Source: `effect@4.0.2/src/Stream.ts:21142`.

Vivid `Stream.toAsyncIterableWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toAsyncIterableWith: {
    <XR>(context: Context.Context<XR>): <A, E, R extends XR>(self: Stream<A, E, R>) => AsyncIterable<A>;
    <A, E, XR, R extends XR>(self: Stream<A, E, R>, context: Context.Context<XR>): AsyncIterable<A>;
};
```

## toAsyncIterableEffect

Creates an effect that yields an `AsyncIterable` using the current services.

Source: `effect@4.0.2/src/Stream.ts:21295`.

Vivid `Stream.toAsyncIterableEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toAsyncIterableEffect: <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<AsyncIterable<A>, never, R>;
```

## toAsyncIterable

Converts a stream to an `AsyncIterable` for `for await...of` consumption.

Source: `effect@4.0.2/src/Stream.ts:21318`.

Vivid `Stream.toAsyncIterable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toAsyncIterable: <A, E>(self: Stream<A, E>) => AsyncIterable<A>;
```

## runIntoPubSub

Runs the stream, publishing elements into the provided PubSub.

Source: `effect@4.0.2/src/Stream.ts:21354`.

Vivid `Stream.runIntoPubSub` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runIntoPubSub: {
    <A>(pubsub: PubSub.PubSub<A>, options?: {
        readonly shutdownOnEnd?: boolean | undefined;
    } | undefined): <E, R>(self: Stream<A, E, R>) => Effect.Effect<void, E, R>;
    <A, E, R>(self: Stream<A, E, R>, pubsub: PubSub.PubSub<A>, options?: {
        readonly shutdownOnEnd?: boolean | undefined;
    } | undefined): Effect.Effect<void, E, R>;
};
```

## toPubSub

Converts a stream to a PubSub of emitted values for concurrent consumption.

Source: `effect@4.0.2/src/Stream.ts:21471`.

Vivid `Stream.toPubSub` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toPubSub: {
    (options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
        readonly shutdownOnEnd?: boolean | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
        readonly replay?: number | undefined;
        readonly shutdownOnEnd?: boolean | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<PubSub.PubSub<A>, never, R | Scope.Scope>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
        readonly shutdownOnEnd?: boolean | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
        readonly replay?: number | undefined;
        readonly shutdownOnEnd?: boolean | undefined;
    }): Effect.Effect<PubSub.PubSub<A>, never, R | Scope.Scope>;
};
```

## toPubSubTake

Converts a stream to a PubSub of `Take` values for concurrent consumption.

Source: `effect@4.0.2/src/Stream.ts:21604`.

Vivid `Stream.toPubSubTake` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toPubSubTake: {
    (options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
        readonly replay?: number | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<PubSub.PubSub<Take.Take<A, E>>, never, R | Scope.Scope>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly capacity: "unbounded";
        readonly replay?: number | undefined;
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
        readonly replay?: number | undefined;
    }): Effect.Effect<PubSub.PubSub<Take.Take<A, E>>, never, R | Scope.Scope>;
};
```

## toQueue

Creates a scoped dequeue that is fed by the stream for concurrent consumption.

Source: `effect@4.0.2/src/Stream.ts:21733`.

Vivid `Stream.toQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toQueue: {
    (options: {
        readonly capacity: "unbounded";
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
    }): <A, E, R>(self: Stream<A, E, R>) => Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, never, R | Scope.Scope>;
    <A, E, R>(self: Stream<A, E, R>, options: {
        readonly capacity: "unbounded";
    } | {
        readonly capacity: number;
        readonly strategy?: "dropping" | "sliding" | "suspend" | undefined;
    }): Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, never, R | Scope.Scope>;
};
```

## runIntoQueue

Runs the stream, offering each element to the provided queue and ending it with `Cause.Done` when the stream completes.

Source: `effect@4.0.2/src/Stream.ts:21852`.

Vivid `Stream.runIntoQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runIntoQueue: {
    <A, E>(queue: Queue.Queue<A, E | Cause.Done>): <R>(self: Stream<A, E, R>) => Effect.Effect<void, never, R>;
    <A, E, R>(self: Stream<A, E, R>, queue: Queue.Queue<A, E | Cause.Done>): Effect.Effect<void, never, R>;
};
```
