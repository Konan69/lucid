# RunnerServer

Import `effect/cluster/RunnerServer`. Source `effect@4.0.2/src/cluster/RunnerServer.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## layerHandlers

Layer that handles runner protocol RPCs by forwarding requests to `Sharding` and `MessageStorage`.

Source: `effect@4.0.2/src/cluster/RunnerServer.ts:58`.

Vivid `RunnerServer.layerHandlers` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerHandlers: Layer.Layer<Rpc.Handler<"Effect"> | Rpc.Handler<"Envelope"> | Rpc.Handler<"Notify"> | Rpc.Handler<"Ping"> | Rpc.Handler<"Stream">, never, MessageStorage.MessageStorage | RpcServer.Protocol | Sharding.Sharding>;
```

## layer

Creates the runner RPC server layer, which receives messages from other runners, forwards them to the `Sharding` layer, and responds to `Ping` requests.

Source: `effect@4.0.2/src/cluster/RunnerServer.ts:200`.

Vivid `RunnerServer.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<never, never, RpcServer.Protocol | Sharding.Sharding | MessageStorage.MessageStorage>;
```

## layerWithClients

Layer that provides `RunnerServer` together with `Runners` and `Sharding` clients.

Source: `effect@4.0.2/src/cluster/RunnerServer.ts:220`.

Vivid `RunnerServer.layerWithClients` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerWithClients: Layer.Layer<Sharding.Sharding | Runners.Runners, never, RpcServer.Protocol | ShardingConfig | Runners.RpcClientProtocol | MessageStorage.MessageStorage | RunnerStorage.RunnerStorage | RunnerHealth.RunnerHealth>;
```

## layerClientOnly

Creates a client-only `Runners` layer.

Source: `effect@4.0.2/src/cluster/RunnerServer.ts:246`.

Vivid `RunnerServer.layerClientOnly` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerClientOnly: Layer.Layer<Sharding.Sharding | Runners.Runners, never, ShardingConfig | Runners.RpcClientProtocol | MessageStorage.MessageStorage | RunnerStorage.RunnerStorage>;
```
