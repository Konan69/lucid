# Clock

Import `effect/Clock`. Source `effect@4.0.2/src/Clock.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 5. Module-name matches in Vivid: 317. apps/desktop/src/main/control.live.test.ts:3, apps/desktop/src/main/control.live.test.ts:139, apps/desktop/src/main/control.ts:2

## Clock

Context reference for the active time service in the environment.

Source: `effect@4.0.2/src/Clock.ts:192`.

Vivid `Clock.Clock` matches: 13. apps/server/src/computers/device.test.ts:360, apps/server/src/computers/device.test.ts:362, apps/server/src/computers/device.test.ts:376 Bare-name matches: 317. Aliased usage is unverified.

```ts
export interface Clock {
    currentTimeMillisUnsafe(): number;
    readonly currentTimeMillis: Effect<number>;
    currentTimeNanosUnsafe(): bigint;
    readonly currentTimeNanos: Effect<bigint>;
    monotonicTimeNanosUnsafe(): bigint;
    readonly monotonicTimeNanos: Effect<bigint>;
    sleep(duration: Duration.Duration): Effect<void>;
}
export declare const Clock: Context.Reference<Clock>;
```

## clockWith

Accesses the current Clock service and uses it to run the provided function.

Source: `effect@4.0.2/src/Clock.ts:229`.

Vivid `Clock.clockWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const clockWith: <A, E, R>(f: (clock: Clock) => Effect<A, E, R>) => Effect<A, E, R>;
```

## currentTimeMillis

Returns an Effect that succeeds with the current Unix time in milliseconds.

Source: `effect@4.0.2/src/Clock.ts:270`.

Vivid `Clock.currentTimeMillis` matches: 178. apps/desktop/src/main/control.live.test.ts:139, apps/desktop/src/main/control.ts:830, apps/desktop/src/main/cookies/copy.ts:46 Bare-name matches: 182. Aliased usage is unverified.

```ts
export declare const currentTimeMillis: Effect<number>;
```

## currentTimeNanos

Returns an Effect that succeeds with the current Unix time in nanoseconds.

Source: `effect@4.0.2/src/Clock.ts:311`.

Vivid `Clock.currentTimeNanos` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const currentTimeNanos: Effect<bigint>;
```

## monotonicTimeNanos

Returns an Effect that succeeds with the current monotonic time in nanoseconds.

Source: `effect@4.0.2/src/Clock.ts:333`.

Vivid `Clock.monotonicTimeNanos` matches: 2. apps/server/src/live/query.ts:21, apps/server/src/live/query.ts:23 Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const monotonicTimeNanos: Effect<bigint>;
```
