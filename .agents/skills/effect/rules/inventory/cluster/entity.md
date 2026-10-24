# Entity

Import `effect/cluster/Entity`. Source `effect@4.0.2/src/cluster/Entity.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 14. Module-name matches in Vivid: 0. No bare-name match.

## Entity

Represents a cluster entity type and the RPC protocol it can handle.

Source: `effect@4.0.2/src/cluster/Entity.ts:74`.

Vivid `Entity.Entity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Entity<in out Type extends string, in out Rpcs extends Rpc.Any> extends Equal.Equal {
    readonly [TypeId]: typeof TypeId;
    readonly type: EntityType;
    readonly protocol: RpcGroup.RpcGroup<Rpcs>;
    getShardGroup(entityId: EntityId): string;
    getShardId(entityId: EntityId): Effect.Effect<ShardId.ShardId, never, Sharding>;
    annotate<I, S>(key: Context.Key<I, S>, value: S): Entity<Type, Rpcs>;
    annotateRpcs<I, S>(key: Context.Key<I, S>, value: S): Entity<Type, Rpcs>;
    annotateMerge<S>(annotation: Context.Context<S>): Entity<Type, Rpcs>;
    annotateRpcsMerge<S>(context: Context.Context<S>): Entity<Type, Rpcs>;
    readonly client: Effect.Effect<(entityId: string) => RpcClient.RpcClient.From<Rpcs, MailboxFull | AlreadyProcessingMessage | PersistenceError | EntityNotAssignedToRunner>, never, Sharding>;
    toLayer<Handlers extends HandlersFrom<Rpcs>, RX = never>(build: Handlers | Effect.Effect<Handlers, never, RX>, options?: {
        readonly maxIdleTime?: Duration.Input | undefined;
        readonly concurrency?: number | "unbounded" | undefined;
        readonly mailboxCapacity?: number | "unbounded" | undefined;
        readonly disableFatalDefects?: boolean | undefined;
        readonly defectRetryPolicy?: Schedule.Schedule<any, unknown> | undefined;
        readonly spanAttributes?: Record<string, string> | undefined;
    }): Layer.Layer<never, never, Exclude<RX, Scope | CurrentAddress | CurrentRunnerAddress> | RpcGroup.HandlersServices<Rpcs, Handlers> | Rpc.ServicesClient<Rpcs> | Rpc.ServicesServer<Rpcs> | Rpc.Middleware<Rpcs> | Sharding>;
    of<Handlers extends HandlersFrom<Rpcs>>(handlers: Handlers): Handlers;
    toLayerQueue<R, RX = never>(build: ((queue: Queue.Dequeue<Envelope.Request<Rpcs>>, replier: Replier<Rpcs>) => Effect.Effect<never, never, R>) | Effect.Effect<(queue: Queue.Dequeue<Envelope.Request<Rpcs>>, replier: Replier<Rpcs>) => Effect.Effect<never, never, R>, never, RX>, options?: {
        readonly maxIdleTime?: Duration.Input | undefined;
        readonly mailboxCapacity?: number | "unbounded" | undefined;
        readonly disableFatalDefects?: boolean | undefined;
        readonly defectRetryPolicy?: Schedule.Schedule<any, unknown> | undefined;
        readonly spanAttributes?: Record<string, string> | undefined;
    }): Layer.Layer<never, never, Exclude<RX, Scope | CurrentAddress | CurrentRunnerAddress> | R | Rpc.ServicesClient<Rpcs> | Rpc.ServicesServer<Rpcs> | Rpc.Middleware<Rpcs> | Sharding>;
}
```

## Any

Type alias for any cluster `Entity`, regardless of entity type or RPC protocol.

Source: `effect@4.0.2/src/cluster/Entity.ts:217`.

Vivid `Entity.Any` matches: 0. No qualified match. Bare-name matches: 35. Aliased usage is unverified.

```ts
export type Any = Entity<string, Rpc.Any>;
```

## HandlersFrom

Maps each RPC in an entity protocol to the handler function expected by `Entity.toLayer`.

Source: `effect@4.0.2/src/cluster/Entity.ts:232`.

Vivid `Entity.HandlersFrom` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type HandlersFrom<Rpc extends Rpc.Any> = {
    readonly [Current in Rpc as Current["_tag"]]: (envelope: Request<Current>) => Rpc.WrapperOr<Rpc.ResultFrom<Current, any>>;
};
```

## isEntity

Returns `true` when the supplied value is a cluster `Entity`.

Source: `effect@4.0.2/src/cluster/Entity.ts:249`.

Vivid `Entity.isEntity` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isEntity: (u: unknown) => u is Any;
```

## fromRpcGroup

Creates a new `Entity` of the specified `type` which will accept messages that adhere to the provided `RpcGroup`.

Source: `effect@4.0.2/src/cluster/Entity.ts:417`.

Vivid `Entity.fromRpcGroup` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromRpcGroup: <const Type extends string, Rpcs extends Rpc.Any>(type: Type, protocol: RpcGroup.RpcGroup<Rpcs>) => Entity<Type, Rpcs>;
```

## make

Creates a new `Entity` of the specified `type` which will accept messages that adhere to the provided schemas.

Source: `effect@4.0.2/src/cluster/Entity.ts:460`.

Vivid `Entity.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <const Type extends string, Rpcs extends ReadonlyArray<Rpc.Any>>(type: Type, protocol: Rpcs) => Entity<Type, Rpcs[number]>;
```

## CurrentAddress

Service tag for the entity address currently being processed.

Source: `effect@4.0.2/src/cluster/Entity.ts:484`.

Vivid `Entity.CurrentAddress` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class CurrentAddress extends CurrentAddress_base {
}
```

## CurrentRunnerAddress

Service tag for the runner address currently registering entity handlers.

Source: `effect@4.0.2/src/cluster/Entity.ts:501`.

Vivid `Entity.CurrentRunnerAddress` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class CurrentRunnerAddress extends CurrentRunnerAddress_base {
}
```

## Replier

Helper types used by the `Replier` API.

Source: `effect@4.0.2/src/cluster/Entity.ts:546`.

Vivid `Entity.Replier` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Replier<Rpcs extends Rpc.Any> {
    readonly succeed: <R extends Rpcs>(request: Envelope.Request<R>, value: Replier.Success<R>) => Effect.Effect<void>;
    readonly fail: <R extends Rpcs>(request: Envelope.Request<R>, error: Rpc.Error<R>) => Effect.Effect<void>;
    readonly failCause: <R extends Rpcs>(request: Envelope.Request<R>, cause: Cause.Cause<Rpc.Error<R>>) => Effect.Effect<void>;
    readonly complete: <R extends Rpcs>(request: Envelope.Request<R>, exit: Exit.Exit<Replier.Success<R>, Rpc.Error<R>>) => Effect.Effect<void>;
}
export declare namespace Replier {
    type Success<R extends Rpc.Any> = Rpc.Success<R> extends Stream.Stream<infer _A, infer _E, infer _R> ? Stream.Stream<_A, _E | Rpc.Error<R>, _R> | Queue.Dequeue<_A, _E | Rpc.Error<R> | Cause.Done> : Rpc.Success<R>;
}
```

## Request

Represents an entity request envelope delivered to entity handlers.

Source: `effect@4.0.2/src/cluster/Entity.ts:576`.

Vivid `Entity.Request` matches: 0. No qualified match. Bare-name matches: 101. Aliased usage is unverified.

```ts
export declare class Request<Rpc extends Rpc.Any> extends Data.Class<Envelope.Request<Rpc> & {
    readonly lastSentChunk: Option.Option<Reply.Chunk<Rpc>>;
}> {
    get lastSentChunkValue(): Option.Option<Rpc.SuccessChunk<Rpc>>;
    get nextSequence(): number;
}
```

## makeTestClient

Builds an in-memory test client for an entity layer.

Source: `effect@4.0.2/src/cluster/Entity.ts:619`.

Vivid `Entity.makeTestClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeTestClient: <Type extends string, Rpcs extends Rpc.Any, LA, LE, LR>(entity: Entity<Type, Rpcs>, layer: Layer.Layer<LA, LE, LR>) => Effect.Effect<(entityId: string) => Effect.Effect<RpcClient.RpcClient<Rpcs>>, LE, Scope | ShardingConfig | Exclude<LR, Sharding> | Rpc.MiddlewareClient<Rpcs>>;
```

## keepAlive

Enables or disables keep-alive for the current entity.

Source: `effect@4.0.2/src/cluster/Entity.ts:731`.

Vivid `Entity.keepAlive` matches: 0. No qualified match. Bare-name matches: 41. Aliased usage is unverified.

```ts
export declare const keepAlive: (enabled: boolean) => Effect.Effect<void, never, Sharding | CurrentAddress>;
```

## KeepAliveRpc

RPC used internally to keep an entity active while a resource is held.

Source: `effect@4.0.2/src/cluster/Entity.ts:788`.

Vivid `Entity.KeepAliveRpc` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const KeepAliveRpc: Rpc.Rpc<"Cluster/Entity/keepAlive", import("../Schema.ts").Void, import("../Schema.ts").Void, import("../Schema.ts").Never, never, never>;
```

## KeepAliveLatch

Service tag for the latch that coordinates entity keep-alive state.

Source: `effect@4.0.2/src/cluster/Entity.ts:804`.

Vivid `Entity.KeepAliveLatch` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class KeepAliveLatch extends KeepAliveLatch_base {
}
```
