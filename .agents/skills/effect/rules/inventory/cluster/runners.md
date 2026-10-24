# Runners

Import `effect/cluster/Runners`. Source `effect@4.0.2/src/cluster/Runners.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 10. Module-name matches in Vivid: 0. No bare-name match.

## Runners

Service for communicating with cluster runners, including pinging runners, sending and notifying messages, coordinating persisted replies, and marking runners unavailable.

Source: `effect@4.0.2/src/cluster/Runners.ts:50`.

Vivid `Runners.Runners` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class Runners extends Runners_base {
}
```

## make

Builds the `Runners` service from remote runner callbacks and adds local message persistence, duplicate request handling, optional local serialization simulation, and polling for persisted replies.

Source: `effect@4.0.2/src/cluster/Runners.ts:165`.

Vivid `Runners.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options: Omit<Runners["Service"], "sendLocal" | "notifyLocal"> & {
    readonly codecFor: RpcSerialization.CodecFor;
}) => Effect.Effect<Runners["Service"], never, MessageStorage.MessageStorage | Snowflake.Generator | ShardingConfig | Scope>;
```

## makeNoop

Creates a no-op `Runners` service that rejects sends with `EntityNotAssignedToRunner` and ignores notifications, pings, and unavailable runner reports.

Source: `effect@4.0.2/src/cluster/Runners.ts:443`.

Vivid `Runners.makeNoop` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeNoop: Effect.Effect<Runners["Service"], never, MessageStorage.MessageStorage | Snowflake.Generator | ShardingConfig | Scope>;
```

## layerNoop

Layer that provides the no-op `Runners` service, using the default snowflake generator.

Source: `effect@4.0.2/src/cluster/Runners.ts:463`.

Vivid `Runners.layerNoop` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerNoop: Layer.Layer<Runners, never, ShardingConfig | MessageStorage.MessageStorage>;
```

## Rpcs

RPC group used for runner-to-runner communication, including ping, notify, effect, stream, and envelope messages.

Source: `effect@4.0.2/src/cluster/Runners.ts:487`.

Vivid `Runners.Rpcs` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare class Rpcs extends Rpcs_base {
}
```

## RpcClient

Client interface generated from the runner RPC group.

Source: `effect@4.0.2/src/cluster/Runners.ts:530`.

Vivid `Runners.RpcClient` matches: 0. No qualified match. Bare-name matches: 37. Aliased usage is unverified.

```ts
export interface RpcClient extends RpcClient_.FromGroup<typeof Rpcs, RpcClientError> {
}
```

## makeRpcClient

Builds a runner RPC client from the current `RpcClient.Protocol`, using the `Runners` span prefix with tracing disabled.

Source: `effect@4.0.2/src/cluster/Runners.ts:540`.

Vivid `Runners.makeRpcClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeRpcClient: Effect.Effect<RpcClient, never, RpcClient_.Protocol | Scope>;
```

## makeRpc

Builds a `Runners` service backed by RPC clients, caching a client per runner address and dispatching ping, notify, effect, stream, and envelope messages over the runner protocol.

Source: `effect@4.0.2/src/cluster/Runners.ts:555`.

Vivid `Runners.makeRpc` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeRpc: Effect.Effect<Runners["Service"], never, Scope | RpcClientProtocol | MessageStorage.MessageStorage | Snowflake.Generator | ShardingConfig>;
```

## layerRpc

Layer that provides an RPC-backed `Runners` service using `RpcClientProtocol`, message storage, sharding configuration, and the default snowflake generator.

Source: `effect@4.0.2/src/cluster/Runners.ts:714`.

Vivid `Runners.layerRpc` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerRpc: Layer.Layer<Runners, never, MessageStorage.MessageStorage | RpcClientProtocol | ShardingConfig>;
```

## RpcClientProtocol

Service that creates RPC client protocols for runner addresses and exposes the codec shared by those protocols.

Source: `effect@4.0.2/src/cluster/Runners.ts:730`.

Vivid `Runners.RpcClientProtocol` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class RpcClientProtocol extends RpcClientProtocol_base {
}
```
