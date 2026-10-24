# ClusterWorkflowEngine

Import `effect/cluster/ClusterWorkflowEngine`. Source `effect@4.0.2/src/cluster/ClusterWorkflowEngine.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## make

Creates a `WorkflowEngine` implementation backed by cluster sharding and message storage.

Source: `effect@4.0.2/src/cluster/ClusterWorkflowEngine.ts:64`.

Vivid `ClusterWorkflowEngine.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: Effect.Effect<{
    readonly register: <Name extends string, Payload extends Workflow.AnyStructSchema, Success extends Schema.Top, Error extends Schema.Top, R>(workflow: Workflow.Workflow<Name, Payload, Success, Error>, execute: (payload: Payload["Type"], executionId: string) => Effect.Effect<Success["Type"], Error["Type"], R>) => Effect.Effect<void, never, Scope.Scope | Exclude<R, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | Workflow.Execution<Name> | Scope.Scope> | Payload["DecodingServices"] | Payload["EncodingServices"] | Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"]>;
    readonly execute: <Name extends string, Payload extends Workflow.AnyStructSchema, Success extends Schema.Top, Error extends Schema.Top, const Discard extends boolean = false>(workflow: Workflow.Workflow<Name, Payload, Success, Error>, options: {
        readonly executionId: string;
        readonly payload: Payload["Type"];
        readonly discard?: Discard | undefined;
        readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown> | undefined;
    }) => Effect.Effect<Discard extends true ? string : Success["Type"], Error["Type"], Payload["EncodingServices"] | Success["DecodingServices"] | Error["DecodingServices"]>;
    readonly poll: <Name extends string, Payload extends Workflow.AnyStructSchema, Success extends Schema.Top, Error extends Schema.Top>(workflow: Workflow.Workflow<Name, Payload, Success, Error>, executionId: string) => Effect.Effect<Option.Option<Workflow.Result<Success["Type"], Error["Type"]>>, never, Success["DecodingServices"] | Error["DecodingServices"]>;
    readonly interrupt: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
    readonly interruptUnsafe: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
    readonly resume: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
    readonly activityExecute: <Success extends Schema.Constraint, Error extends Schema.Constraint, R>(activity: Activity.Activity<Success, Error, R>, attempt: number) => Effect.Effect<Workflow.Result<Success["Type"], Error["Type"]>, never, Success["DecodingServices"] | Error["DecodingServices"] | R | WorkflowEngine.WorkflowInstance>;
    readonly deferredResult: <Success extends Schema.Constraint, Error extends Schema.Constraint>(deferred: DurableDeferred.DurableDeferred<Success, Error>) => Effect.Effect<Option.Option<Exit.Exit<Success["Type"], Error["Type"]>>, never, WorkflowEngine.WorkflowInstance>;
    readonly deferredDone: <Success extends Schema.Constraint, Error extends Schema.Constraint>(deferred: DurableDeferred.DurableDeferred<Success, Error>, options: {
        readonly workflowName: string;
        readonly executionId: string;
        readonly deferredName: string;
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>;
    }) => Effect.Effect<void, never, Success["EncodingServices"] | Error["EncodingServices"]>;
    readonly scheduleClock: (workflow: Workflow.Any, options: {
        readonly executionId: string;
        readonly clock: DurableClock.DurableClock;
    }) => Effect.Effect<void>;
}, never, MessageStorage | Scope.Scope | Sharding.Sharding>;
```

## layer

Layer that provides `WorkflowEngine.WorkflowEngine` using the cluster workflow engine implementation.

Source: `effect@4.0.2/src/cluster/ClusterWorkflowEngine.ts:932`.

Vivid `ClusterWorkflowEngine.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<WorkflowEngine.WorkflowEngine, never, Sharding.Sharding | MessageStorage>;
```
