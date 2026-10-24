# Activity

Import `effect/workflow/Activity`. Source `effect@4.0.2/src/workflow/Activity.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 8. Module-name matches in Vivid: 6. apps/server/src/computers/store.ts:211, apps/server/src/computers/store.ts:859, apps/server/src/connections/curation.json:12583

## Activity

Durable workflow activity that behaves as an `Effect` and records its name, result schemas, annotations, and encoded execution form for the workflow engine.

Source: `effect@4.0.2/src/workflow/Activity.ts:38`.

Vivid `Activity.Activity` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export interface Activity<Success extends Schema.Constraint = Schema.Void, Error extends Schema.Constraint = Schema.Never, R = never> extends Effect.Effect<Success["Type"], Error["Type"], Success["DecodingServices"] | Error["DecodingServices"] | R | WorkflowEngine | WorkflowInstance> {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly successSchema: Success;
    readonly errorSchema: Error;
    readonly exitSchema: Schema.Exit<Success, Error, Schema.Defect>;
    readonly exitSchemaPartial: Schema.Exit<Success, Error, Schema.Unknown>;
    readonly annotations: Context.Context<never>;
    annotate<I, S>(key: Context.Key<I, S>, value: S): Activity<Success, Error, R>;
    annotateMerge<I>(annotations: Context.Context<I>): Activity<Success, Error, R>;
    readonly execute: Effect.Effect<Success["Type"], Error["Type"], Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"] | R | Scope | WorkflowEngine | WorkflowInstance>;
    readonly executeEncoded: Effect.Effect<unknown, unknown, Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"] | R | Scope | WorkflowEngine | WorkflowInstance>;
}
```

## Any

Type-erased activity shape for APIs that only need the activity identity, name, annotations, and encoded execution.

Source: `effect@4.0.2/src/workflow/Activity.ts:97`.

Vivid `Activity.Any` matches: 0. No qualified match. Bare-name matches: 35. Aliased usage is unverified.

```ts
export interface Any {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly executeEncoded: Effect.Effect<any, any, any>;
    readonly annotations: Context.Context<never>;
}
```

## AnyWithProps

Type-erased activity shape that also exposes success and error schemas for derived workflow APIs.

Source: `effect@4.0.2/src/workflow/Activity.ts:112`.

Vivid `Activity.AnyWithProps` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AnyWithProps {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly successSchema: Schema.Top;
    readonly errorSchema: Schema.Top;
    readonly executeEncoded: Effect.Effect<any, any, any>;
}
```

## make

Creates a workflow activity from an effect, using the provided schemas to encode successes and failures for durable execution.

Source: `effect@4.0.2/src/workflow/Activity.ts:135`.

Vivid `Activity.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <R, Success extends Schema.Constraint = Schema.Void, Error extends Schema.Constraint = Schema.Never>(options: {
    readonly name: string;
    readonly success?: Success | undefined;
    readonly error?: Error | undefined;
    readonly execute: Effect.Effect<Success["Type"], Error["Type"], R>;
    readonly interruptRetryPolicy?: Schedule.Schedule<any, Cause.Cause<unknown>> | undefined;
    readonly annotations?: Context.Context<never> | undefined;
}) => Activity<Success, Error, Exclude<R, WorkflowInstance | WorkflowEngine | Scope>>;
```

## retry

Retries an effect with `Effect.retry` while updating `CurrentAttempt` for each attempt.

Source: `effect@4.0.2/src/workflow/Activity.ts:227`.

Vivid `Activity.retry` matches: 0. No qualified match. Bare-name matches: 148. Aliased usage is unverified.

```ts
export declare const retry: {
    <E, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(options: O): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Retry.Return<R, E, A, O>;
    <A, E, R, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(self: Effect.Effect<A, E, R>, options: O): Effect.Retry.Return<R, E, A, O>;
};
```

## CurrentAttempt

Context reference containing the current activity retry attempt, defaulting to `1`.

Source: `effect@4.0.2/src/workflow/Activity.ts:263`.

Vivid `Activity.CurrentAttempt` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const CurrentAttempt: Context.Reference<number>;
```

## idempotencyKey

Computes a deterministic activity idempotency key from the current workflow execution ID, the supplied name, and optionally the current attempt.

Source: `effect@4.0.2/src/workflow/Activity.ts:276`.

Vivid `Activity.idempotencyKey` matches: 0. No qualified match. Bare-name matches: 81. Aliased usage is unverified.

```ts
export declare const idempotencyKey: (name: string, options?: {
    readonly includeAttempt?: boolean | undefined;
} | undefined) => Effect.Effect<string, never, WorkflowInstance>;
```

## raceAll

Runs a non-empty collection of activities as a durable race and returns the first completed success or failure using unioned success and error schemas.

Source: `effect@4.0.2/src/workflow/Activity.ts:302`.

Vivid `Activity.raceAll` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const raceAll: <const Activities extends NonEmptyReadonlyArray<Any>>(name: string, activities: Activities) => Effect.Effect<Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _A["Type"] : never, Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _E["Type"] : never, (Activities[number] extends Activity<infer Success, infer Error, infer R> ? Success["DecodingServices"] | Error["DecodingServices"] | R : never) | WorkflowEngine | WorkflowInstance>;
```
