# Schedule

Import `effect/Schedule`. Source `effect@4.0.2/src/Schedule.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 39. Module-name matches in Vivid: 73. apps/desktop/src/main/device.ts:22, apps/desktop/src/main/device.ts:208, apps/desktop/src/main/device.ts:210

## Schedule

The Schedule namespace contains types and utilities for working with schedules.

Source: `effect@4.0.2/src/Schedule.ts:120`.

Vivid `Schedule.Schedule` matches: 2. apps/server/src/library/ingestion.ts:82, apps/server/src/library/worker.ts:41 Bare-name matches: 73. Aliased usage is unverified.

```ts
export interface Schedule<out Output, in Input = unknown, out Error = never, out Env = never> extends Schedule.Variance<Output, Input, Error, Env>, Pipeable {
}
export declare namespace Schedule {
    interface Variance<out Output, in Input, out Error, out Env> {
        readonly [TypeId]: VarianceStruct<Output, Input, Error, Env>;
    }
    interface VarianceStruct<out Output, in Input, out Error, out Env> {
        readonly _Out: Covariant<Output>;
        readonly _In: Contravariant<Input>;
        readonly _Error: Covariant<Error>;
        readonly _Env: Covariant<Env>;
    }
}
```

## InputMetadata

Metadata provided to schedule functions containing timing and input information.

Source: `effect@4.0.2/src/Schedule.ts:66`.

Vivid `Schedule.InputMetadata` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface InputMetadata<Input> {
    readonly input: Input;
    readonly attempt: number;
    readonly start: number;
    readonly now: number;
    readonly elapsed: number;
    readonly elapsedSincePrevious: number;
}
```

## Metadata

Extended metadata that includes both input metadata and the output value from the schedule.

Source: `effect@4.0.2/src/Schedule.ts:82`.

Vivid `Schedule.Metadata` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export interface Metadata<Output = unknown, Input = unknown> extends InputMetadata<Input> {
    readonly output: Output;
    readonly duration: Duration.Duration;
}
```

## CurrentMetadata

Context reference containing metadata for the currently running schedule step.

Source: `effect@4.0.2/src/Schedule.ts:101`.

Vivid `Schedule.CurrentMetadata` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const CurrentMetadata: Context.Reference<Metadata<unknown, unknown>>;
```

## Output

Extracts the output type from a `Schedule`.

Source: `effect@4.0.2/src/Schedule.ts:167`.

Vivid `Schedule.Output` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export type Output<S> = S extends Schedule<infer Output, any, any, any> ? Output : never;
```

## Input

Extracts the input type from a `Schedule`.

Source: `effect@4.0.2/src/Schedule.ts:176`.

Vivid `Schedule.Input` matches: 0. No qualified match. Bare-name matches: 143. Aliased usage is unverified.

```ts
export type Input<S> = S extends Schedule<any, infer Input, any, any> ? Input : never;
```

## Error

Extracts the error type from a `Schedule`.

Source: `effect@4.0.2/src/Schedule.ts:185`.

Vivid `Schedule.Error` matches: 0. No qualified match. Bare-name matches: 149. Aliased usage is unverified.

```ts
export type Error<S> = S extends Schedule<any, any, infer Error, any> ? Error : never;
```

## Env

Extracts the service requirements from a `Schedule`.

Source: `effect@4.0.2/src/Schedule.ts:194`.

Vivid `Schedule.Env` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type Env<S> = S extends Schedule<any, any, any, infer Env> ? Env : never;
```

## isSchedule

Type guard that checks if a value is a Schedule.

Source: `effect@4.0.2/src/Schedule.ts:228`.

Vivid `Schedule.isSchedule` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isSchedule: (u: unknown) => u is Schedule<unknown, never, unknown, unknown>;
```

## fromStep

Creates a Schedule from a step function that returns a Pull.

Source: `effect@4.0.2/src/Schedule.ts:262`.

Vivid `Schedule.fromStep` matches: 1. apps/server/src/channels/worker.ts:13 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const fromStep: <Input, Output, EnvX, Error, ErrorX, Env>(step: Effect<(now: number, input: Input) => Pull.Pull<[
    Output,
    Duration.Duration
], ErrorX, Output, EnvX>, Error, Env>) => Schedule<Output, Input, Error | Pull.ExcludeDone<ErrorX>, Env | EnvX>;
```

## fromStepWithMetadata

Creates a Schedule from a step function that receives metadata about the schedule's execution.

Source: `effect@4.0.2/src/Schedule.ts:319`.

Vivid `Schedule.fromStepWithMetadata` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromStepWithMetadata: <Input, Output, EnvX, ErrorX, Error, Env>(step: Effect<(options: InputMetadata<Input>) => Pull.Pull<[
    Output,
    Duration.Duration
], ErrorX, Output, EnvX>, Error, Env>) => Schedule<Output, Input, Error | Pull.ExcludeDone<ErrorX>, Env | EnvX>;
```

## toStep

Extracts the step function from a Schedule.

Source: `effect@4.0.2/src/Schedule.ts:358`.

Vivid `Schedule.toStep` matches: 2. apps/server/src/channels/worker.ts:15, apps/server/src/channels/worker.ts:17 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const toStep: <Output, Input, Error, Env>(schedule: Schedule<Output, Input, Error, Env>) => Effect<(now: number, input: Input) => Pull.Pull<[
    Output,
    Duration.Duration
], Error, Output, Env>, never, Env>;
```

## toStepWithMetadata

Extracts a step function from a `Schedule` that sleeps for each computed delay and returns metadata for the completed step.

Source: `effect@4.0.2/src/Schedule.ts:392`.

Vivid `Schedule.toStepWithMetadata` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toStepWithMetadata: <Output, Input, Error, Env>(schedule: Schedule<Output, Input, Error, Env>) => Effect<(input: Input) => Pull.Pull<Metadata<Output, Input>, Error, Output, Env>, never, Env>;
```

## toStepWithSleep

Extracts a step function from a Schedule that automatically handles sleep delays.

Source: `effect@4.0.2/src/Schedule.ts:445`.

Vivid `Schedule.toStepWithSleep` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toStepWithSleep: <Output, Input, Error, Env>(schedule: Schedule<Output, Input, Error, Env>) => Effect<(input: Input) => Pull.Pull<Output, Error, Output, Env>, never, Env>;
```

## addDelay

Returns a new `Schedule` that adds the delay computed by the specified effectful function to the next recurrence of the schedule.

Source: `effect@4.0.2/src/Schedule.ts:482`.

Vivid `Schedule.addDelay` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const addDelay: {
    <Output, Input, Error2 = never, Env2 = never>(f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>): <Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output, Input, Error | Error2, Env | Env2>;
    <Output, Input, Error, Env, Error2 = never, Env2 = never>(self: Schedule<Output, Input, Error, Env>, f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>): Schedule<Output, Input, Error | Error2, Env | Env2>;
};
```

## concat

Returns a schedule that runs `self` to completion, then runs `other`, and merges their outputs.

Source: `effect@4.0.2/src/Schedule.ts:568`.

Vivid `Schedule.concat` matches: 0. No qualified match. Bare-name matches: 55. Aliased usage is unverified.

```ts
export declare const concat: {
    <Output2, Input2, Error2, Env2>(other: Schedule<Output2, Input2, Error2, Env2>): <Output, Input, Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output | Output2, Input & Input2, Error | Error2, Env | Env2>;
    <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(self: Schedule<Output, Input, Error, Env>, other: Schedule<Output2, Input2, Error2, Env2>): Schedule<Output | Output2, Input & Input2, Error | Error2, Env | Env2>;
};
```

## concatResult

Returns a schedule that runs `self` to completion, then runs `other`, and preserves which schedule produced each output.

Source: `effect@4.0.2/src/Schedule.ts:639`.

Vivid `Schedule.concatResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const concatResult: {
    <Output2, Input2, Error2, Env2>(other: Schedule<Output2, Input2, Error2, Env2>): <Output, Input, Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Result.Result<Output2, Output>, Input & Input2, Error | Error2, Env | Env2>;
    <Output, Input, Error, Env, Output2, Input2, Error2, Env2>(self: Schedule<Output, Input, Error, Env>, other: Schedule<Output2, Input2, Error2, Env2>): Schedule<Result.Result<Output2, Output>, Input & Input2, Error | Error2, Env | Env2>;
};
```

## max

Combines schedules by recurring while all schedules want to recur, using the maximum delay between recurrences and outputting that maximum delay.

Source: `effect@4.0.2/src/Schedule.ts:856`.

Vivid `Schedule.max` matches: 1. packages/client/state/src/display.ts:285 Bare-name matches: 310. Aliased usage is unverified.

```ts
export declare const max: <const Schedules extends NonEmptyReadonlyArray<Schedule<any, any, any, any>>>(schedules: Schedules) => Schedule<Duration.Duration, UnionToIntersection<Input<Schedules[number]>>, Error<Schedules[number]>, Env<Schedules[number]>>;
```

## cron

Returns a new `Schedule` that recurs on the specified `Cron` schedule and outputs the duration between recurrences.

Source: `effect@4.0.2/src/Schedule.ts:917`.

Vivid `Schedule.cron` matches: 0. No qualified match. Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const cron: {
    (expression: Cron.Cron): Schedule<Duration.Duration, unknown, Cron.CronParseError>;
    (expression: string, tz?: string | DateTime.TimeZone): Schedule<Duration.Duration, unknown, Cron.CronParseError>;
};
```

## duration

Returns a schedule that recurs once after the specified duration.

Source: `effect@4.0.2/src/Schedule.ts:994`.

Vivid `Schedule.duration` matches: 0. No qualified match. Bare-name matches: 206. Aliased usage is unverified.

```ts
export declare const duration: (durationInput: Duration.Input) => Schedule<Duration.Duration>;
```

## during

Returns a new `Schedule` that will always recur, but only during the specified `duration` of time.

Source: `effect@4.0.2/src/Schedule.ts:1025`.

Vivid `Schedule.during` matches: 0. No qualified match. Bare-name matches: 64. Aliased usage is unverified.

```ts
export declare const during: (duration: Duration.Input) => Schedule<Duration.Duration>;
```

## min

Combines schedules by recurring while at least one schedule wants to recur, using the minimum delay between recurrences and outputting that minimum delay.

Source: `effect@4.0.2/src/Schedule.ts:1059`.

Vivid `Schedule.min` matches: 4. apps/desktop/src/main/device.ts:208, apps/desktop/src/main/device.ts:210, apps/desktop/src/main/egress.ts:741 Bare-name matches: 343. Aliased usage is unverified.

```ts
export declare const min: <const Schedules extends NonEmptyReadonlyArray<Schedule<any, any, any, any>>>(schedules: Schedules) => Schedule<Duration.Duration, UnionToIntersection<Input<Schedules[number]>>, Error<Schedules[number]>, Env<Schedules[number]>>;
```

## exponential

Schedule that always recurs, but will wait a certain amount between repetitions, given by `base * factor.pow(n)`, where `n` is the number of repetitions so far. Returns the current duration between recurrences.

Source: `effect@4.0.2/src/Schedule.ts:1127`.

Vivid `Schedule.exponential` matches: 8. apps/desktop/src/main/device.ts:211, apps/desktop/src/main/egress.ts:742, apps/mobile/src/data/session.ts:208 Bare-name matches: 10. Aliased usage is unverified.

```ts
export declare const exponential: (base: Duration.Input, factor?: number) => Schedule<Duration.Duration>;
```

## fibonacci

Schedule that always recurs, increasing delays by summing the preceding two delays (similar to the Fibonacci sequence). Returns the current duration between recurrences.

Source: `effect@4.0.2/src/Schedule.ts:1160`.

Vivid `Schedule.fibonacci` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fibonacci: (one: Duration.Input) => Schedule<Duration.Duration>;
```

## fixed

Returns a `Schedule` that recurs on the specified fixed `interval` and outputs the number of repetitions of the schedule so far.

Source: `effect@4.0.2/src/Schedule.ts:1212`.

Vivid `Schedule.fixed` matches: 0. No qualified match. Bare-name matches: 108. Aliased usage is unverified.

```ts
export declare const fixed: (interval: Duration.Input) => Schedule<number>;
```

## map

Returns a new `Schedule` that maps each schedule decision to a new output using the full schedule metadata.

Source: `effect@4.0.2/src/Schedule.ts:1267`.

Vivid `Schedule.map` matches: 0. No qualified match. Bare-name matches: 1501. Aliased usage is unverified.

```ts
export declare const map: {
    <Input, Output, Output2, Error2 = never, Env2 = never>(f: (metadata: Metadata<Output, Input>) => Output2 | Effect<Output2, Error2, Env2>): <Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output2, Input, Error | Error2, Env | Env2>;
    <Output, Input, Error, Env, Output2, Error2 = never, Env2 = never>(self: Schedule<Output, Input, Error, Env>, f: (metadata: Metadata<Output, Input>) => Output2 | Effect<Output2, Error2, Env2>): Schedule<Output2, Input, Error | Error2, Env | Env2>;
};
```

## modifyDelay

Returns a new `Schedule` that modifies the delay of the next recurrence of the schedule using the specified effectful function.

Source: `effect@4.0.2/src/Schedule.ts:1386`.

Vivid `Schedule.modifyDelay` matches: 2. apps/server/src/channels/worker.ts:8, apps/server/src/connections/migration.ts:277 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const modifyDelay: {
    <Output, Input, Error2 = never, Env2 = never>(f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>): <Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output, Input, Error | Error2, Env | Env2>;
    <Output, Input, Error, Env, Error2 = never, Env2 = never>(self: Schedule<Output, Input, Error, Env>, f: (metadata: Metadata<Output, Input>) => Effect<Duration.Input, Error2, Env2>): Schedule<Output, Input, Error | Error2, Env | Env2>;
};
```

## jittered

Returns a new `Schedule` that randomly adjusts each recurrence delay.

Source: `effect@4.0.2/src/Schedule.ts:1487`.

Vivid `Schedule.jittered` matches: 1. apps/server/src/channels/worker.ts:7 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const jittered: <Output, Input, Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output, Input, Error, Env>;
```

## passthrough

Returns a new `Schedule` that outputs the inputs of the specified schedule.

Source: `effect@4.0.2/src/Schedule.ts:1520`.

Vivid `Schedule.passthrough` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const passthrough: <Output, Input, Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Input, Input, Error, Env>;
```

## recurs

Returns a `Schedule` which can only be stepped the specified number of `times` before it terminates.

Source: `effect@4.0.2/src/Schedule.ts:1565`.

Vivid `Schedule.recurs` matches: 1. packages/client/state/src/display.ts:285 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const recurs: (times: number) => Schedule<number>;
```

## spaced

Returns a schedule that recurs continuously, each repetition spaced the specified duration from the last run.

Source: `effect@4.0.2/src/Schedule.ts:1595`.

Vivid `Schedule.spaced` matches: 17. apps/desktop/src/main/device.ts:212, apps/desktop/src/main/egress.ts:743, apps/server/src/approvals/sweeper.ts:33 Bare-name matches: 18. Aliased usage is unverified.

```ts
export declare const spaced: (duration: Duration.Input) => Schedule<number>;
```

## tap

Returns a new `Schedule` that allows execution of an effectful function for every decision of the schedule, but does not alter the inputs and outputs of the schedule.

Source: `effect@4.0.2/src/Schedule.ts:1632`.

Vivid `Schedule.tap` matches: 0. No qualified match. Bare-name matches: 38. Aliased usage is unverified.

```ts
export declare const tap: {
    <Output, Input, X, Error2, Env2>(f: (metadata: Metadata<Output, Input>) => Effect<X, Error2, Env2>): <Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output, Input, Error | Error2, Env | Env2>;
    <Output, Input, Error, Env, X, Error2, Env2>(self: Schedule<Output, Input, Error, Env>, f: (metadata: Metadata<Output, Input>) => Effect<X, Error2, Env2>): Schedule<Output, Input, Error | Error2, Env | Env2>;
};
```

## upTo

Returns a new `Schedule` that limits an existing schedule by elapsed duration, number of outputs, or both.

Source: `effect@4.0.2/src/Schedule.ts:1755`.

Vivid `Schedule.upTo` matches: 1. apps/server/src/memory/helix.ts:1095 Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const upTo: {
    (options: {
        readonly duration?: Duration.Input | undefined;
        readonly times?: number | undefined;
    }): <Output, Input, Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output, Input, Error, Env>;
    <Output, Input, Error, Env>(self: Schedule<Output, Input, Error, Env>, options: {
        readonly duration?: Duration.Input | undefined;
        readonly times?: number | undefined;
    }): Schedule<Output, Input, Error, Env>;
};
```

## while

Returns a new schedule that continues while the predicate returns `true`.

Source: `effect@4.0.2/src/Schedule.ts:1935`.

Vivid `Schedule.while` matches: 0. No qualified match. Bare-name matches: 933. Aliased usage is unverified.

```ts
declare const while_: {
    <Input, Output, Meta extends Metadata<Output, Input>>(predicate: (metadata: Metadata<Output, Input>) => metadata is Meta): <Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Meta["output"], Meta["input"], Error, Env>;
    <Input, Output, Error2 = never, Env2 = never>(predicate: (metadata: Metadata<Output, Input>) => boolean | Effect<boolean, Error2, Env2>): <Error, Env>(self: Schedule<Output, Input, Error, Env>) => Schedule<Output, Input, Error | Error2, Env | Env2>;
    <Output, Input, Error, Env, Meta extends Metadata<Output, Input>>(self: Schedule<Output, Input, Error, Env>, predicate: (metadata: Metadata<Output, Input>) => metadata is Meta): Schedule<Meta["output"], Meta["input"], Error, Env>;
    <Output, Input, Error, Env, Error2 = never, Env2 = never>(self: Schedule<Output, Input, Error, Env>, predicate: (metadata: Metadata<Output, Input>) => boolean | Effect<boolean, Error2, Env2>): Schedule<Output, Input, Error | Error2, Env | Env2>;
};
export { while_ as while };
```

## windowed

Schedule that divides the timeline to `interval`-long windows, and sleeps until the nearest window boundary every time it recurs.

Source: `effect@4.0.2/src/Schedule.ts:1970`.

Vivid `Schedule.windowed` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const windowed: (interval: Duration.Input) => Schedule<number>;
```

## forever

Returns a new `Schedule` that will recur forever.

Source: `effect@4.0.2/src/Schedule.ts:2008`.

Vivid `Schedule.forever` matches: 8. apps/server/src/library/adoption.test.ts:90, apps/server/src/library/adoption.test.ts:124, apps/server/src/library/durability.test.ts:158 Bare-name matches: 32. Aliased usage is unverified.

```ts
export declare const forever: Schedule<number>;
```

## once

Returns a schedule that recurs immediately once, then completes.

Source: `effect@4.0.2/src/Schedule.ts:2023`.

Vivid `Schedule.once` matches: 0. No qualified match. Bare-name matches: 1196. Aliased usage is unverified.

```ts
export declare const once: Schedule<void>;
```

## identity

Creates a schedule that always recurs, passing inputs directly as outputs.

Source: `effect@4.0.2/src/Schedule.ts:2051`.

Vivid `Schedule.identity` matches: 0. No qualified match. Bare-name matches: 10754. Aliased usage is unverified.

```ts
declare const identity_: <A>() => Schedule<A, A>;
export { identity_ as identity };
```

## setInputType

Sets the input type of the provided schedule without altering its behavior.

Source: `effect@4.0.2/src/Schedule.ts:2081`.

Vivid `Schedule.setInputType` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setInputType: <T>() => <Output, Error, Env>(self: Schedule<Output, T, Error, Env>) => Schedule<Output, T, Error, Env>;
```
