# WorkflowEngine

Import `effect/workflow/WorkflowEngine`. Source `effect@4.0.2/src/workflow/WorkflowEngine.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 7. Module-name matches in Vivid: 0. No bare-name match.

## WorkflowEngine

Service that represents workflow runtimes, responsible for registering and executing workflows and coordinating activities, durable deferreds, interrupts, resumes, and clocks.

Source: `effect@4.0.2/src/workflow/WorkflowEngine.ts:39`.

Vivid `WorkflowEngine.WorkflowEngine` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class WorkflowEngine extends WorkflowEngine_base {
}
```

## WorkflowInstance

Service that contains workflow runtime state for one execution.

Source: `effect@4.0.2/src/workflow/WorkflowEngine.ts:231`.

Vivid `WorkflowEngine.WorkflowInstance` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class WorkflowInstance extends WorkflowInstance_base {
    static initial(workflow: Workflow.Any, executionId: string, scope?: Scope.Closeable): WorkflowInstance["Service"];
}
```

## DeferredState

Tracks live workflow runs so deferred completions can wake them.

Source: `effect@4.0.2/src/workflow/WorkflowEngine.ts:316`.

Vivid `WorkflowEngine.DeferredState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DeferredState {
    readonly trackRun: <A, E, R>(instance: WorkflowInstance["Service"], effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, WorkflowInstance>>;
    readonly deferredDone: (executionId: string, name: string) => Effect.Effect<void>;
}
```

## makeDeferredState

Creates deferred state shared by workflow engines.

Source: `effect@4.0.2/src/workflow/WorkflowEngine.ts:337`.

Vivid `WorkflowEngine.makeDeferredState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeDeferredState: () => DeferredState;
```

## Encoded

Low-level workflow engine contract that works with encoded payloads and results before `makeUnsafe` adds typed schema decoding and encoding.

Source: `effect@4.0.2/src/workflow/WorkflowEngine.ts:382`.

Vivid `WorkflowEngine.Encoded` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export interface Encoded {
    readonly register: (workflow: Workflow.Any, execute: (payload: object, executionId: string) => Effect.Effect<unknown, unknown, WorkflowInstance | WorkflowEngine>) => Effect.Effect<void, never, Scope.Scope>;
    readonly execute: <const Discard extends boolean>(workflow: Workflow.Any, options: {
        readonly executionId: string;
        readonly payload: object;
        readonly discard: Discard;
        readonly parent?: WorkflowInstance["Service"] | undefined;
    }) => Effect.Effect<Discard extends true ? void : Workflow.Result<unknown, unknown>>;
    readonly poll: (workflow: Workflow.Any, executionId: string) => Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>>;
    readonly interrupt: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
    readonly interruptUnsafe: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
    readonly resume: (workflow: Workflow.Any, executionId: string) => Effect.Effect<void>;
    readonly activityExecute: (activity: Activity.Any, attempt: number) => Effect.Effect<Workflow.Result<unknown, unknown>, never, WorkflowInstance>;
    readonly deferredResult: (deferred: DurableDeferred.Any) => Effect.Effect<Option.Option<Exit.Exit<unknown, unknown>>, never, WorkflowInstance>;
    readonly deferredDone: (options: {
        readonly workflowName: string;
        readonly executionId: string;
        readonly deferredName: string;
        readonly exit: Exit.Exit<unknown, unknown>;
    }) => Effect.Effect<void>;
    readonly scheduleClock: (workflow: Workflow.Any, options: {
        readonly executionId: string;
        readonly clock: DurableClock;
    }) => Effect.Effect<void>;
}
```

## makeUnsafe

Builds a typed `WorkflowEngine` service from a low-level encoded implementation.

Source: `effect@4.0.2/src/workflow/WorkflowEngine.ts:464`.

Vivid `WorkflowEngine.makeUnsafe` matches: 0. No qualified match. Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const makeUnsafe: (options: Encoded) => WorkflowEngine["Service"];
```

## layerMemory

Layer that provides an in-memory `WorkflowEngine`.

Source: `effect@4.0.2/src/workflow/WorkflowEngine.ts:664`.

Vivid `WorkflowEngine.layerMemory` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerMemory: Layer.Layer<WorkflowEngine>;
```
