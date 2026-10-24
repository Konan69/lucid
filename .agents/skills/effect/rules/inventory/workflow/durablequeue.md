# DurableQueue

Import `effect/workflow/DurableQueue`. Source `effect@4.0.2/src/workflow/DurableQueue.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 6. Module-name matches in Vivid: 0. No bare-name match.

## TypeId

Runtime identifier attached to `DurableQueue` values.

Source: `effect@4.0.2/src/workflow/DurableQueue.ts:48`.

Vivid `DurableQueue.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type TypeId = "~effect/workflow/DurableQueue";
export declare const TypeId: TypeId;
```

## DurableQueue

Durable workflow queue definition containing a payload schema, idempotency key, and deferred used to await worker results.

Source: `effect@4.0.2/src/workflow/DurableQueue.ts:58`.

Vivid `DurableQueue.DurableQueue` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DurableQueue<Payload extends Schema.Top, Success extends Schema.Top = Schema.Void, Error extends Schema.Top = Schema.Never> {
    readonly [TypeId]: TypeId;
    readonly name: string;
    readonly payloadSchema: Payload;
    readonly idempotencyKey: (payload: Payload["Type"]) => string;
    readonly deferred: DurableDeferred.DurableDeferred<Success, Error>;
}
```

## make

Creates a `DurableQueue` that waits for persisted items to finish processing using a `DurableDeferred`.

Source: `effect@4.0.2/src/workflow/DurableQueue.ts:130`.

Vivid `DurableQueue.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <Payload extends Schema.Top | Schema.Struct.Fields, Success extends Schema.Top = Schema.Void, Error extends Schema.Top = Schema.Never>(options: {
    readonly name: string;
    readonly payload: Payload;
    readonly idempotencyKey: (payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload> : Payload["Type"]) => string;
    readonly success?: Success | undefined;
    readonly error?: Error | undefined;
}) => DurableQueue<Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload, Success, Error>;
```

## process

Adds an item to the queue and wait for a worker to process it.

Source: `effect@4.0.2/src/workflow/DurableQueue.ts:192`.

Vivid `DurableQueue.process` matches: 0. No qualified match. Bare-name matches: 638. Aliased usage is unverified.

```ts
export declare const process: <Payload extends Schema.Top, Success extends Schema.Top, Error extends Schema.Top>(self: DurableQueue<Payload, Success, Error>, payload: Payload["~type.make.in"], options?: {
    readonly retrySchedule?: Schedule.Schedule<any, PersistedQueue.PersistedQueueError> | undefined;
}) => Effect.Effect<Success["Type"], Error["Type"], WorkflowEngine | WorkflowInstance | PersistedQueue.PersistedQueueFactory | Payload["EncodingServices"] | Payload["DecodingServices"] | Success["DecodingServices"] | Error["DecodingServices"]>;
```

## makeWorker

Create a worker effect that processes items from the durable queue.

Source: `effect@4.0.2/src/workflow/DurableQueue.ts:270`.

Vivid `DurableQueue.makeWorker` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeWorker: <Payload extends Schema.Top, Success extends Schema.Top, Error extends Schema.Top, R>(self: DurableQueue<Payload, Success, Error>, f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>, options?: {
    readonly concurrency?: number | undefined;
} | undefined) => Effect.Effect<never, never, WorkflowEngine | PersistedQueue.PersistedQueueFactory | R | Payload["EncodingServices"] | Payload["DecodingServices"] | Success["EncodingServices"] | Error["EncodingServices"]>;
```

## worker

Create a layer that runs workers for the durable queue.

Source: `effect@4.0.2/src/workflow/DurableQueue.ts:358`.

Vivid `DurableQueue.worker` matches: 0. No qualified match. Bare-name matches: 108. Aliased usage is unverified.

```ts
export declare const worker: <Payload extends Schema.Top, Success extends Schema.Top, Error extends Schema.Top, R>(self: DurableQueue<Payload, Success, Error>, f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>, options?: {
    readonly concurrency?: number | undefined;
} | undefined) => Layer.Layer<never, never, WorkflowEngine | PersistedQueue.PersistedQueueFactory | R | Payload["EncodingServices"] | Payload["DecodingServices"] | Success["EncodingServices"] | Error["EncodingServices"]>;
```
