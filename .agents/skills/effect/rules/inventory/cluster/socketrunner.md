# SocketRunner

Import `effect/cluster/SocketRunner`. Source `effect@4.0.2/src/cluster/SocketRunner.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## layer

Layer that runs a cluster runner over the socket RPC protocol, providing `Sharding` and `Runners` clients and logging the socket listen address.

Source: `effect@4.0.2/src/cluster/SocketRunner.ts:68`.

Vivid `SocketRunner.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<Sharding.Sharding | Runners.Runners, never, Runners.RpcClientProtocol | ShardingConfig | RpcSerialization.RpcSerialization | SocketServer | MessageStorage | RunnerStorage.RunnerStorage | RunnerHealth>;
```

## layerClientOnly

Provides a client-only socket runner layer that provides `Sharding` and `Runners` clients without starting a runner server or receiving shard assignments.

Source: `effect@4.0.2/src/cluster/SocketRunner.ts:96`.

Vivid `SocketRunner.layerClientOnly` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerClientOnly: Layer.Layer<Sharding.Sharding | Runners.Runners, never, Runners.RpcClientProtocol | ShardingConfig | MessageStorage | RunnerStorage.RunnerStorage>;
```
