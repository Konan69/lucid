# Workflow

Import `effect/workflow/Workflow`. Source `effect@4.0.2/src/workflow/Workflow.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 25. Module-name matches in Vivid: 1. apps/server/src/channels/ledger.ts:58

## Workflow

Durable workflow definition with typed payload, success, and error schemas plus operations for execution, polling, interruption, resumption, and registration.

Source: `effect@4.0.2/src/workflow/Workflow.ts:47`.

Vivid `Workflow.Workflow` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export interface Workflow<Tag extends string, Payload extends AnyStructSchema, Success extends Schema.Top, Error extends Schema.Top> {
    new (_: never): {};
    readonly [TypeId]: typeof TypeId;
    readonly _tag: Tag;
    readonly payloadSchema: Payload;
    readonly successSchema: Success;
    readonly errorSchema: Error;
    readonly annotations: Context.Context<never>;
    readonly idempotencyKey: (payload: Payload["Type"]) => string;
    readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown> | undefined;
    annotate<I, S>(key: Context.Key<I, S>, value: S): Workflow<Tag, Payload, Success, Error>;
    annotateMerge<I>(annotations: Context.Context<I>): Workflow<Tag, Payload, Success, Error>;
    readonly execute: <const Discard extends boolean = false>(payload: Payload["~type.make.in"], options?: {
        readonly discard?: Discard;
    }) => Effect.Effect<Discard extends true ? string : Success["Type"], Discard extends true ? never : Error["Type"], WorkflowEngine | Payload["EncodingServices"] | Success["DecodingServices"] | Error["DecodingServices"]>;
    readonly poll: (executionId: string) => Effect.Effect<Option.Option<Result<Success["Type"], Error["Type"]>>, never, WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]>;
    readonly interrupt: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
    readonly resume: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
    readonly toLayer: <R>(execute: (payload: Payload["Type"], executionId: string) => Effect.Effect<Success["Type"], Error["Type"], R>) => Layer.Layer<never, never, WorkflowEngine | Exclude<R, WorkflowEngine | WorkflowInstance | Execution<Tag> | Scope.Scope> | Payload["DecodingServices"] | Payload["EncodingServices"] | Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"]>;
    readonly executionId: (payload: Payload["~type.make.in"]) => Effect.Effect<string>;
    readonly withCompensation: {
        <A, R2>(compensation: (value: A, cause: Cause.Cause<Error["Type"]>) => Effect.Effect<void, never, R2>): <E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | R2 | WorkflowInstance | Execution<Tag> | Scope.Scope>;
        <A, E, R, R2>(effect: Effect.Effect<A, E, R>, compensation: (value: A, cause: Cause.Cause<Error["Type"]>) => Effect.Effect<void, never, R2>): Effect.Effect<A, E, R | R2 | WorkflowInstance | Execution<Tag> | Scope.Scope>;
    };
}
```

## AnyStructSchema

Schema constraint for workflow payload schemas that expose struct fields.

Source: `effect@4.0.2/src/workflow/Workflow.ts:198`.

Vivid `Workflow.AnyStructSchema` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AnyStructSchema extends Schema.Top {
    readonly fields: Schema.Struct.Fields;
}
```

## Execution

Type-level marker for services associated with a specific workflow execution tag.

Source: `effect@4.0.2/src/workflow/Workflow.ts:210`.

Vivid `Workflow.Execution` matches: 0. No qualified match. Bare-name matches: 14. Aliased usage is unverified.

```ts
export interface Execution<Tag extends string> {
    readonly _: unique symbol;
    readonly _tag: Tag;
}
```

## Any

Type-erased workflow shape for APIs that operate on workflows without preserving their specific payload, success, or error types.

Source: `effect@4.0.2/src/workflow/Workflow.ts:223`.

Vivid `Workflow.Any` matches: 0. No qualified match. Bare-name matches: 35. Aliased usage is unverified.

```ts
export interface Any {
    new (_: never): {};
    readonly [TypeId]: typeof TypeId;
    readonly _tag: string;
    readonly executionId: (payload: any) => Effect.Effect<string>;
    readonly payloadSchema: AnyStructSchema;
    readonly successSchema: Schema.Top;
    readonly errorSchema: Schema.Top;
    readonly annotations: Context.Context<never>;
    readonly idempotencyKey: (payload: any) => string;
    readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown> | undefined;
}
```

## AnyWithProps

Type-erased workflow shape that also exposes executable operations needed by workflow proxy and engine helpers.

Source: `effect@4.0.2/src/workflow/Workflow.ts:245`.

Vivid `Workflow.AnyWithProps` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AnyWithProps extends Any {
    readonly payloadSchema: AnyStructSchema;
    readonly successSchema: Schema.Top;
    readonly errorSchema: Schema.Top;
    readonly execute: (payload: any, options?: {
        readonly discard?: boolean;
    }) => Effect.Effect<any, any, any>;
    readonly resume: (executionId: string) => Effect.Effect<void, never, WorkflowEngine>;
}
```

## PayloadSchema

Extracts the payload schema from a `Workflow`.

Source: `effect@4.0.2/src/workflow/Workflow.ts:265`.

Vivid `Workflow.PayloadSchema` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type PayloadSchema<W> = W extends Workflow<infer _Name, infer _Payload, infer _Success, infer _Error> ? _Payload : never;
```

## RequirementsClient

Computes the schema services required by clients that execute or poll workflows.

Source: `effect@4.0.2/src/workflow/Workflow.ts:281`.

Vivid `Workflow.RequirementsClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type RequirementsClient<Workflows extends Any> = Workflows extends Workflow<infer _Name, infer _Payload, infer _Success, infer _Error> ? _Payload["EncodingServices"] | _Success["DecodingServices"] | _Error["DecodingServices"] : never;
```

## RequirementsHandler

Computes the schema services required by handlers that decode workflow payloads and encode workflow results.

Source: `effect@4.0.2/src/workflow/Workflow.ts:300`.

Vivid `Workflow.RequirementsHandler` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type RequirementsHandler<Workflows extends Any> = Workflows extends Workflow<infer _Name, infer _Payload, infer _Success, infer _Error> ? _Payload["DecodingServices"] | _Payload["EncodingServices"] | _Success["DecodingServices"] | _Success["EncodingServices"] | _Error["DecodingServices"] | _Error["EncodingServices"] : never;
```

## make

Creates a durable workflow definition with schemas, annotations, and deterministic execution IDs derived from the workflow tag and idempotency key.

Source: `effect@4.0.2/src/workflow/Workflow.ts:442`.

Vivid `Workflow.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <const Tag extends string, Payload extends Schema.Struct.Fields | AnyStructSchema, Success extends Schema.Top = Schema.Void, Error extends Schema.Top = Schema.Never>(tag: Tag, options: {
    readonly payload: Payload;
    readonly idempotencyKey: (payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload> : Payload["Type"]) => string;
    readonly success?: Success;
    readonly error?: Error;
    readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown> | undefined;
    readonly annotations?: Context.Context<never>;
}) => Workflow<Tag, Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload, Success, Error>;
```

## isResult

Returns `true` when a value is a workflow `Result`.

Source: `effect@4.0.2/src/workflow/Workflow.ts:485`.

Vivid `Workflow.isResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isResult: <A = unknown, E = unknown>(u: unknown) => u is Result<A, E>;
```

## Result

Creates a schema for workflow results using the supplied success and error schemas.

Source: `effect@4.0.2/src/workflow/Workflow.ts:647`.

Vivid `Workflow.Result` matches: 0. No qualified match. Bare-name matches: 522. Aliased usage is unverified.

```ts
export type Result<A, E> = Complete<A, E> | Suspended;
export declare const Result: <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly success: Success;
    readonly error: Error;
}) => Schema.Union<readonly [
    CompleteSchema<Success, Error>,
    typeof Suspended
]>;
```

## ResultEncoded

Schema for encoded workflow results with generic success and error payloads.

Source: `effect@4.0.2/src/workflow/Workflow.ts:664`.

Vivid `Workflow.ResultEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type ResultEncoded<A, E> = CompleteEncoded<A, E> | typeof Suspended.Encoded;
export declare const ResultEncoded: Schema.Codec<ResultEncoded<any, any>>;
```

## CompleteEncoded

Encoded representation of a completed workflow result containing an encoded `Exit`.

Source: `effect@4.0.2/src/workflow/Workflow.ts:518`.

Vivid `Workflow.CompleteEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface CompleteEncoded<A, E> {
    readonly _tag: "Complete";
    readonly exit: ExitEncoded<A, E>;
}
```

## CompleteSchema

Schema constructor for `Complete` workflow results using the supplied success and error schemas.

Source: `effect@4.0.2/src/workflow/Workflow.ts:531`.

Vivid `Workflow.CompleteSchema` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface CompleteSchema<Success extends Schema.Constraint, Error extends Schema.Constraint> extends Schema.declareConstructor<Complete<Success["Type"], Error["Type"]>, Complete<Success["Encoded"], Error["Encoded"]>, readonly [
    Schema.Exit<Success, Error, Schema.Defect>
]> {
    readonly success: Success;
    readonly error: Error;
}
```

## Complete

Represents a completed workflow execution with its success or failure `Exit`.

Source: `effect@4.0.2/src/workflow/Workflow.ts:552`.

Vivid `Workflow.Complete` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare class Complete<A, E> extends Complete_base<{
    readonly exit: Exit.Exit<A, E>;
}> {
    readonly [ResultTypeId] = "~effect/workflow/Workflow/Result";
    static Schema<Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly success: Success;
        readonly error: Error;
    }): CompleteSchema<Success, Error>;
}
```

## Suspended

Represents a suspended workflow execution, optionally carrying the cause that triggered suspension.

Source: `effect@4.0.2/src/workflow/Workflow.ts:624`.

Vivid `Workflow.Suspended` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class Suspended extends Suspended_base {
    readonly [ResultTypeId] = "~effect/workflow/Workflow/Result";
}
```

## intoResult

Runs an effect as a workflow execution and converts its outcome into a `Result`, handling suspension, defect capture, interruption, and workflow scope finalization.

Source: `effect@4.0.2/src/workflow/Workflow.ts:682`.

Vivid `Workflow.intoResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const intoResult: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Result<A, E>, never, Exclude<R, Scope.Scope> | WorkflowInstance>;
```

## wrapActivityResult

Wraps an activity-like effect so workflow suspension waits for currently running activities to finish or suspend.

Source: `effect@4.0.2/src/workflow/Workflow.ts:758`.

Vivid `Workflow.wrapActivityResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const wrapActivityResult: <A, E, R>(effect: Effect.Effect<A, E, R>, isSuspend: (value: A) => boolean) => Effect.Effect<A, E, R | WorkflowInstance>;
```

## scope

Accesses the workflow scope, which is only closed when the workflow execution fully completes.

Source: `effect@4.0.2/src/workflow/Workflow.ts:862`.

Vivid `Workflow.scope` matches: 0. No qualified match. Bare-name matches: 837. Aliased usage is unverified.

```ts
export declare const scope: Effect.Effect<Scope.Scope, never, WorkflowInstance>;
```

## provideScope

Provides the workflow scope to the given effect, and closes the scope only when the workflow execution fully completes.

Source: `effect@4.0.2/src/workflow/Workflow.ts:878`.

Vivid `Workflow.provideScope` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const provideScope: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Scope.Scope> | WorkflowInstance>;
```

## addFinalizer

Adds an exit finalizer to the current workflow scope, preserving the services available when the finalizer is registered.

Source: `effect@4.0.2/src/workflow/Workflow.ts:899`.

Vivid `Workflow.addFinalizer` matches: 0. No qualified match. Bare-name matches: 129. Aliased usage is unverified.

```ts
export declare const addFinalizer: <R>(f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>) => Effect.Effect<void, never, WorkflowInstance | R>;
```

## withCompensation

Adds compensation logic to an effect inside a Workflow.

Source: `effect@4.0.2/src/workflow/Workflow.ts:936`.

Vivid `Workflow.withCompensation` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withCompensation: {
    <A, R2>(compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>): <E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | R2 | WorkflowInstance | Scope.Scope>;
    <A, E, R, R2>(effect: Effect.Effect<A, E, R>, compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>): Effect.Effect<A, E, R | R2 | WorkflowInstance | Scope.Scope>;
};
```

## suspend

Marks a workflow instance as suspended and interrupts the current fiber to stop execution until it is resumed.

Source: `effect@4.0.2/src/workflow/Workflow.ts:1005`.

Vivid `Workflow.suspend` matches: 0. No qualified match. Bare-name matches: 52. Aliased usage is unverified.

```ts
export declare const suspend: (instance: WorkflowInstance["Service"]) => Effect.Effect<never>;
```

## CaptureDefects

Captures defects for a workflow and includes them in the result of the workflow or its activities.

Source: `effect@4.0.2/src/workflow/Workflow.ts:1023`.

Vivid `Workflow.CaptureDefects` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const CaptureDefects: Context.Reference<boolean>;
```

## SuspendOnFailure

Marks a workflow to suspend when it encounters any error.

Source: `effect@4.0.2/src/workflow/Workflow.ts:1041`.

Vivid `Workflow.SuspendOnFailure` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const SuspendOnFailure: Context.Reference<boolean>;
```
