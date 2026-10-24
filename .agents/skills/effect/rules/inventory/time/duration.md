# Duration

Import `effect/Duration`. Source `effect@4.0.2/src/Duration.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 57. Module-name matches in Vivid: 106. apps/desktop/src/main/computer.ts:6, apps/desktop/src/main/computer.ts:419, apps/desktop/src/main/control.ts:4

## Duration

Represents a span of time with high precision, supporting operations from nanoseconds to weeks.

Source: `effect@4.0.2/src/Duration.ts:86`.

Vivid `Duration.Duration` matches: 3. apps/server/src/computers/screen.test.ts:77, apps/server/src/library/extraction.ts:157, apps/server/src/library/extraction.ts:181 Bare-name matches: 106. Aliased usage is unverified.

```ts
export interface Duration extends Equal.Equal, Pipeable, Inspectable.Inspectable {
    readonly [TypeId]: typeof TypeId;
    readonly value: DurationValue;
}
```

## DurationValue

Tagged representation of a `Duration` value.

Source: `effect@4.0.2/src/Duration.ts:113`.

Vivid `Duration.DurationValue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type DurationValue = {
    _tag: "Millis";
    millis: number;
} | {
    _tag: "Nanos";
    nanos: bigint;
} | {
    _tag: "Infinity";
} | {
    _tag: "NegativeInfinity";
};
```

## Unit

Valid time units that can be used in duration string representations.

Source: `effect@4.0.2/src/Duration.ts:133`.

Vivid `Duration.Unit` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export type Unit = "nano" | "nanos" | "micro" | "micros" | "milli" | "millis" | "second" | "seconds" | "minute" | "minutes" | "hour" | "hours" | "day" | "days" | "week" | "weeks";
```

## Input

Valid input types that can be converted to a Duration.

Source: `effect@4.0.2/src/Duration.ts:177`.

Vivid `Duration.Input` matches: 8. apps/server/src/connections/effects.ts:249, apps/server/src/connections/effects.ts:287, apps/server/src/connections/effects.ts:406 Bare-name matches: 143. Aliased usage is unverified.

```ts
export type Input = Duration | number | bigint | readonly [
    seconds: number,
    nanos: number
] | `${number} ${Unit}` | "Infinity" | "-Infinity" | DurationObject;
```

## DurationObject

An object with optional duration components that can be combined to create a Duration. All fields are optional and additive.

Source: `effect@4.0.2/src/Duration.ts:209`.

Vivid `Duration.DurationObject` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DurationObject {
    readonly weeks?: number | undefined;
    readonly days?: number | undefined;
    readonly hours?: number | undefined;
    readonly minutes?: number | undefined;
    readonly seconds?: number | undefined;
    readonly milliseconds?: number | undefined;
    readonly microseconds?: number | undefined;
    readonly nanoseconds?: number | undefined;
}
```

## fromInputUnsafe

Decodes a `Duration.Input` into a `Duration`.

Source: `effect@4.0.2/src/Duration.ts:249`.

Vivid `Duration.fromInputUnsafe` matches: 5. apps/server/src/connections/tools.ts:204, apps/server/src/decisions/model.ts:287, apps/server/src/decisions/model.ts:311 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const fromInputUnsafe: (input: Input) => Duration;
```

## fromInput

Decodes a `Input` value into a `Duration` safely, returning `Option.none()` if decoding fails.

Source: `effect@4.0.2/src/Duration.ts:351`.

Vivid `Duration.fromInput` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const fromInput: (u: Input) => Option.Option<Duration>;
```

## isDuration

Checks whether a value is a Duration.

Source: `effect@4.0.2/src/Duration.ts:446`.

Vivid `Duration.isDuration` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isDuration: (u: unknown) => u is Duration;
```

## isFinite

Checks whether a Duration is finite (not infinite).

Source: `effect@4.0.2/src/Duration.ts:464`.

Vivid `Duration.isFinite` matches: 1. packages/agent/runtime/src/notes.ts:138 Bare-name matches: 32. Aliased usage is unverified.

```ts
export declare const isFinite: (self: Duration) => boolean;
```

## isZero

Checks whether a Duration is zero.

Source: `effect@4.0.2/src/Duration.ts:483`.

Vivid `Duration.isZero` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isZero: (self: Duration) => boolean;
```

## isNegative

Returns `true` if the duration is negative (strictly less than zero).

Source: `effect@4.0.2/src/Duration.ts:512`.

Vivid `Duration.isNegative` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isNegative: (self: Duration) => boolean;
```

## isPositive

Returns `true` if the duration is positive (strictly greater than zero).

Source: `effect@4.0.2/src/Duration.ts:542`.

Vivid `Duration.isPositive` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isPositive: (self: Duration) => boolean;
```

## abs

Returns the absolute value of the duration.

Source: `effect@4.0.2/src/Duration.ts:571`.

Vivid `Duration.abs` matches: 0. No qualified match. Bare-name matches: 19. Aliased usage is unverified.

```ts
export declare const abs: (self: Duration) => Duration;
```

## negate

Returns the negated duration.

Source: `effect@4.0.2/src/Duration.ts:599`.

Vivid `Duration.negate` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const negate: (self: Duration) => Duration;
```

## zero

A Duration representing zero time.

Source: `effect@4.0.2/src/Duration.ts:627`.

Vivid `Duration.zero` matches: 3. apps/server/src/code/source.ts:195, apps/server/src/memory/helix.ts:1290, packages/agent/runtime/src/delivery.ts:81 Bare-name matches: 59. Aliased usage is unverified.

```ts
export declare const zero: Duration;
```

## infinity

A Duration representing infinite time.

Source: `effect@4.0.2/src/Duration.ts:644`.

Vivid `Duration.infinity` matches: 2. apps/server/src/memory/helix.ts:1290, packages/agent/runtime/src/delivery.ts:81 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const infinity: Duration;
```

## negativeInfinity

A Duration representing negative infinite time.

Source: `effect@4.0.2/src/Duration.ts:661`.

Vivid `Duration.negativeInfinity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const negativeInfinity: Duration;
```

## nanos

Creates a Duration from nanoseconds.

Source: `effect@4.0.2/src/Duration.ts:678`.

Vivid `Duration.nanos` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const nanos: (nanos: bigint) => Duration;
```

## micros

Creates a Duration from microseconds.

Source: `effect@4.0.2/src/Duration.ts:695`.

Vivid `Duration.micros` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const micros: (micros: bigint) => Duration;
```

## millis

Creates a Duration from milliseconds.

Source: `effect@4.0.2/src/Duration.ts:712`.

Vivid `Duration.millis` matches: 6. apps/desktop/src/main/computer.ts:419, apps/desktop/src/main/control.ts:835, apps/desktop/src/main/egress.test.ts:756 Bare-name matches: 54. Aliased usage is unverified.

```ts
export declare const millis: (millis: number) => Duration;
```

## seconds

Creates a Duration from seconds.

Source: `effect@4.0.2/src/Duration.ts:729`.

Vivid `Duration.seconds` matches: 17. apps/desktop/src/main/control.ts:692, apps/desktop/src/main/egress.ts:105, apps/desktop/src/main/egress.ts:145 Bare-name matches: 291. Aliased usage is unverified.

```ts
export declare const seconds: (seconds: number) => Duration;
```

## minutes

Creates a Duration from minutes.

Source: `effect@4.0.2/src/Duration.ts:746`.

Vivid `Duration.minutes` matches: 11. apps/mobile/src/data/google.ts:186, apps/server/src/computers/store.ts:370, apps/server/src/computers/store.ts:377 Bare-name matches: 117. Aliased usage is unverified.

```ts
export declare const minutes: (minutes: number) => Duration;
```

## hours

Creates a Duration from hours.

Source: `effect@4.0.2/src/Duration.ts:763`.

Vivid `Duration.hours` matches: 1. apps/server/src/observability/export.test.ts:1266 Bare-name matches: 42. Aliased usage is unverified.

```ts
export declare const hours: (hours: number) => Duration;
```

## days

Creates a Duration from days.

Source: `effect@4.0.2/src/Duration.ts:780`.

Vivid `Duration.days` matches: 0. No qualified match. Bare-name matches: 34. Aliased usage is unverified.

```ts
export declare const days: (days: number) => Duration;
```

## weeks

Creates a Duration from weeks.

Source: `effect@4.0.2/src/Duration.ts:797`.

Vivid `Duration.weeks` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const weeks: (weeks: number) => Duration;
```

## toMillis

Converts a Duration to milliseconds.

Source: `effect@4.0.2/src/Duration.ts:815`.

Vivid `Duration.toMillis` matches: 11. apps/desktop/src/main/egress.test.ts:756, apps/server/src/code/computer.live.test.ts:64, apps/server/src/computers/boat.live.test.ts:30 Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const toMillis: (self: Input) => number;
```

## toSeconds

Converts a Duration to seconds.

Source: `effect@4.0.2/src/Duration.ts:839`.

Vivid `Duration.toSeconds` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toSeconds: (self: Input) => number;
```

## toMinutes

Converts a Duration to minutes.

Source: `effect@4.0.2/src/Duration.ts:863`.

Vivid `Duration.toMinutes` matches: 1. apps/server/src/computers/store.ts:378 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const toMinutes: (self: Input) => number;
```

## toHours

Converts a Duration to hours.

Source: `effect@4.0.2/src/Duration.ts:887`.

Vivid `Duration.toHours` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toHours: (self: Input) => number;
```

## toDays

Converts a Duration to days.

Source: `effect@4.0.2/src/Duration.ts:911`.

Vivid `Duration.toDays` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toDays: (self: Input) => number;
```

## toWeeks

Converts a Duration to weeks.

Source: `effect@4.0.2/src/Duration.ts:935`.

Vivid `Duration.toWeeks` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toWeeks: (self: Input) => number;
```

## toNanosUnsafe

Gets the duration in nanoseconds as a bigint.

Source: `effect@4.0.2/src/Duration.ts:975`.

Vivid `Duration.toNanosUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toNanosUnsafe: (input: Input) => bigint;
```

## toNanos

Gets the duration in nanoseconds safely as an `Option<bigint>`.

Source: `effect@4.0.2/src/Duration.ts:1008`.

Vivid `Duration.toNanos` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toNanos: (self: Input) => Option.Option<bigint>;
```

## toHrTime

Converts a Duration to high-resolution time format [seconds, nanoseconds].

Source: `effect@4.0.2/src/Duration.ts:1025`.

Vivid `Duration.toHrTime` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toHrTime: (input: Input) => [
    seconds: number,
    nanos: number
];
```

## match

Pattern matches on the representation of a `Duration`.

Source: `effect@4.0.2/src/Duration.ts:1064`.

Vivid `Duration.match` matches: 0. No qualified match. Bare-name matches: 790. Aliased usage is unverified.

```ts
export declare const match: {
    <A, B, C, D = C>(options: {
        readonly onMillis: (millis: number) => A;
        readonly onNanos: (nanos: bigint) => B;
        readonly onInfinity: () => C;
        readonly onNegativeInfinity?: () => D;
    }): (self: Duration) => A | B | C | D;
    <A, B, C, D = C>(self: Duration, options: {
        readonly onMillis: (millis: number) => A;
        readonly onNanos: (nanos: bigint) => B;
        readonly onInfinity: () => C;
        readonly onNegativeInfinity?: () => D;
    }): A | B | C | D;
};
```

## matchPair

Pattern matches on two `Duration`s, providing handlers that receive both values.

Source: `effect@4.0.2/src/Duration.ts:1172`.

Vivid `Duration.matchPair` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const matchPair: {
    <A, B, C>(that: Duration, options: {
        readonly onMillis: (self: number, that: number) => A;
        readonly onNanos: (self: bigint, that: bigint) => B;
        readonly onInfinity: (self: Duration, that: Duration) => C;
    }): (self: Duration) => A | B | C;
    <A, B, C>(self: Duration, that: Duration, options: {
        readonly onMillis: (self: number, that: number) => A;
        readonly onNanos: (self: bigint, that: bigint) => B;
        readonly onInfinity: (self: Duration, that: Duration) => C;
    }): A | B | C;
};
```

## Order

Provides an `Order` instance for comparing `Duration` values.

Source: `effect@4.0.2/src/Duration.ts:1274`.

Vivid `Duration.Order` matches: 0. No qualified match. Bare-name matches: 141. Aliased usage is unverified.

```ts
export declare const Order: order.Order<Duration>;
```

## between

Returns `true` if a `Duration` is greater than or equal to `minimum` and less than or equal to `maximum`, according to `Duration.Order`.

Source: `effect@4.0.2/src/Duration.ts:1326`.

Vivid `Duration.between` matches: 0. No qualified match. Bare-name matches: 254. Aliased usage is unverified.

```ts
export declare const between: {
    (options: {
        minimum: Duration;
        maximum: Duration;
    }): (self: Duration) => boolean;
    (self: Duration, options: {
        minimum: Duration;
        maximum: Duration;
    }): boolean;
};
```

## Equivalence

Provides an `Equivalence` instance for comparing `Duration` values.

Source: `effect@4.0.2/src/Duration.ts:1418`.

Vivid `Duration.Equivalence` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const Equivalence: Equ.Equivalence<Duration>;
```

## min

Returns the smaller of two Durations.

Source: `effect@4.0.2/src/Duration.ts:1440`.

Vivid `Duration.min` matches: 3. apps/server/src/channels/worker.ts:9, apps/server/src/connections/migration.ts:278, apps/server/src/connections/tools.ts:202 Bare-name matches: 343. Aliased usage is unverified.

```ts
export declare const min: {
    (that: Duration): (self: Duration) => Duration;
    (self: Duration, that: Duration): Duration;
};
```

## max

Returns the larger of two Durations.

Source: `effect@4.0.2/src/Duration.ts:1490`.

Vivid `Duration.max` matches: 0. No qualified match. Bare-name matches: 310. Aliased usage is unverified.

```ts
export declare const max: {
    (that: Duration): (self: Duration) => Duration;
    (self: Duration, that: Duration): Duration;
};
```

## clamp

Returns a `Duration` constrained between a minimum and maximum value.

Source: `effect@4.0.2/src/Duration.ts:1543`.

Vivid `Duration.clamp` matches: 0. No qualified match. Bare-name matches: 26. Aliased usage is unverified.

```ts
export declare const clamp: {
    (options: {
        minimum: Duration;
        maximum: Duration;
    }): (self: Duration) => Duration;
    (self: Duration, options: {
        minimum: Duration;
        maximum: Duration;
    }): Duration;
};
```

## divide

Divides a `Duration` by a finite, non-zero number safely.

Source: `effect@4.0.2/src/Duration.ts:1606`.

Vivid `Duration.divide` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare const divide: {
    (by: number): (self: Duration) => Option.Option<Duration>;
    (self: Duration, by: number): Option.Option<Duration>;
};
```

## divideUnsafe

Divides a `Duration` by a number using fallback rules instead of returning an `Option`.

Source: `effect@4.0.2/src/Duration.ts:1703`.

Vivid `Duration.divideUnsafe` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const divideUnsafe: {
    (by: number): (self: Duration) => Duration;
    (self: Duration, by: number): Duration;
};
```

## times

Returns a `Duration` multiplied by a number.

Source: `effect@4.0.2/src/Duration.ts:1814`.

Vivid `Duration.times` matches: 0. No qualified match. Bare-name matches: 104. Aliased usage is unverified.

```ts
export declare const times: {
    (times: number): (self: Duration) => Duration;
    (self: Duration, times: number): Duration;
};
```

## subtract

Subtracts one Duration from another. The result can be negative.

Source: `effect@4.0.2/src/Duration.ts:1896`.

Vivid `Duration.subtract` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const subtract: {
    (that: Duration): (self: Duration) => Duration;
    (self: Duration, that: Duration): Duration;
};
```

## sum

Adds two Durations together.

Source: `effect@4.0.2/src/Duration.ts:1988`.

Vivid `Duration.sum` matches: 1. apps/server/src/computers/store.ts:831 Bare-name matches: 23. Aliased usage is unverified.

```ts
export declare const sum: {
    (that: Duration): (self: Duration) => Duration;
    (self: Duration, that: Duration): Duration;
};
```

## isLessThan

Checks whether the first Duration is less than the second.

Source: `effect@4.0.2/src/Duration.ts:2075`.

Vivid `Duration.isLessThan` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isLessThan: {
    (that: Duration): (self: Duration) => boolean;
    (self: Duration, that: Duration): boolean;
};
```

## isLessThanOrEqualTo

Checks whether the first Duration is less than or equal to the second.

Source: `effect@4.0.2/src/Duration.ts:2128`.

Vivid `Duration.isLessThanOrEqualTo` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isLessThanOrEqualTo: {
    (that: Duration): (self: Duration) => boolean;
    (self: Duration, that: Duration): boolean;
};
```

## isGreaterThan

Checks whether the first Duration is greater than the second.

Source: `effect@4.0.2/src/Duration.ts:2184`.

Vivid `Duration.isGreaterThan` matches: 0. No qualified match. Bare-name matches: 15. Aliased usage is unverified.

```ts
export declare const isGreaterThan: {
    (that: Duration): (self: Duration) => boolean;
    (self: Duration, that: Duration): boolean;
};
```

## isGreaterThanOrEqualTo

Checks whether the first Duration is greater than or equal to the second.

Source: `effect@4.0.2/src/Duration.ts:2237`.

Vivid `Duration.isGreaterThanOrEqualTo` matches: 0. No qualified match. Bare-name matches: 18. Aliased usage is unverified.

```ts
export declare const isGreaterThanOrEqualTo: {
    (that: Duration): (self: Duration) => boolean;
    (self: Duration, that: Duration): boolean;
};
```

## equals

Checks whether two Durations are equal.

Source: `effect@4.0.2/src/Duration.ts:2293`.

Vivid `Duration.equals` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const equals: {
    (that: Duration): (self: Duration) => boolean;
    (self: Duration, that: Duration): boolean;
};
```

## parts

Decomposes a `Duration` into normalized signed components.

Source: `effect@4.0.2/src/Duration.ts:2360`.

Vivid `Duration.parts` matches: 0. No qualified match. Bare-name matches: 229. Aliased usage is unverified.

```ts
export declare const parts: (self: Duration) => {
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
    millis: number;
    nanos: number;
};
```

## format

Converts a `Duration` to a human readable string.

Source: `effect@4.0.2/src/Duration.ts:2425`.

Vivid `Duration.format` matches: 0. No qualified match. Bare-name matches: 91. Aliased usage is unverified.

```ts
export declare const format: (self: Duration) => string;
```

## ReducerSum

Reducer for summing `Duration`s.

Source: `effect@4.0.2/src/Duration.ts:2488`.

Vivid `Duration.ReducerSum` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const ReducerSum: Reducer.Reducer<Duration>;
```

## CombinerMax

Combiner that returns the maximum `Duration`.

Source: `effect@4.0.2/src/Duration.ts:2504`.

Vivid `Duration.CombinerMax` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const CombinerMax: Combiner.Combiner<Duration>;
```

## CombinerMin

Combiner that returns the minimum `Duration`.

Source: `effect@4.0.2/src/Duration.ts:2520`.

Vivid `Duration.CombinerMin` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const CombinerMin: Combiner.Combiner<Duration>;
```
