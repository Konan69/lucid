# TestClock

Import `effect/testing/TestClock`. Source `effect@4.0.2/src/testing/TestClock.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 7. Module-name matches in Vivid: 263. apps/desktop/scripts/control.ts:8, apps/desktop/scripts/control.ts:176, apps/desktop/scripts/control.ts:186

## TestClock

Namespace containing `TestClock` configuration and state types.

Source: `effect@4.0.2/src/testing/TestClock.ts:141`.

Vivid `TestClock.TestClock` matches: 0. No qualified match. Bare-name matches: 263. Aliased usage is unverified.

```ts
export interface TestClock extends Clock.Clock {
    adjust(duration: Duration.Input): Effect.Effect<void>;
    setTime(timestamp: number): Effect.Effect<void>;
    withLive<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}
export declare namespace TestClock {
    interface Options {
        readonly warningDelay?: Duration.Input;
    }
    interface State {
        readonly timestamp: number;
        readonly sleeps: ReadonlyArray<[
            number,
            Latch.Latch
        ]>;
    }
}
```

## make

Creates a `TestClock` with optional configuration.

Source: `effect@4.0.2/src/testing/TestClock.ts:248`.

Vivid `TestClock.make` matches: 1. apps/server/tests/case.ts:22 Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options?: TestClock.Options | undefined) => Effect.Effect<{
    currentTimeMillisUnsafe: () => number;
    currentTimeNanosUnsafe: () => bigint;
    monotonicTimeNanosUnsafe: () => bigint;
    currentTimeMillis: Effect.Effect<number, never, never>;
    currentTimeNanos: Effect.Effect<bigint, never, never>;
    monotonicTimeNanos: Effect.Effect<bigint, never, never>;
    adjust: (input: Duration.Input) => Effect.Effect<void, never, never>;
    setTime: (timestamp: number) => Effect.Effect<void, never, never>;
    sleep: (duration: Duration.Duration) => Effect.Effect<void, never, never>;
    withLive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, never>>;
}, never, import("../Scope.ts").Scope>;
```

## layer

Creates a `Layer` which constructs a `TestClock`.

Source: `effect@4.0.2/src/testing/TestClock.ts:441`.

Vivid `TestClock.layer` matches: 1. apps/desktop/scripts/control.ts:186 Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: (options?: TestClock.Options) => Layer.Layer<TestClock>;
```

## testClockWith

Retrieves the `TestClock` service for this test and uses it to run the specified workflow.

Source: `effect@4.0.2/src/testing/TestClock.ts:475`.

Vivid `TestClock.testClockWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const testClockWith: <A, E, R>(f: (testClock: TestClock) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
```

## adjust

Accesses a `TestClock` instance in the context and increments the time by the specified duration, running any actions scheduled for on or before the new time in order.

Source: `effect@4.0.2/src/testing/TestClock.ts:514`.

Vivid `TestClock.adjust` matches: 171. apps/desktop/scripts/control.ts:176, apps/desktop/src/main/computer.test.ts:189, apps/desktop/src/main/computer.test.ts:205 Bare-name matches: 177. Aliased usage is unverified.

```ts
export declare const adjust: (duration: Duration.Input) => Effect.Effect<void>;
```

## setTime

Sets the current clock time to the specified `timestamp`. Any effects that were scheduled to occur on or before the new time will be run in order.

Source: `effect@4.0.2/src/testing/TestClock.ts:552`.

Vivid `TestClock.setTime` matches: 36. apps/server/src/appearance/announcements.test.ts:149, apps/server/src/approvals/store.test.ts:504, apps/server/src/approvals/store.test.ts:510 Bare-name matches: 36. Aliased usage is unverified.

```ts
export declare const setTime: (timestamp: number) => Effect.Effect<void>;
```

## withLive

Executes the specified effect with the live `Clock` instead of the `TestClock`.

Source: `effect@4.0.2/src/testing/TestClock.ts:589`.

Vivid `TestClock.withLive` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withLive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
```
