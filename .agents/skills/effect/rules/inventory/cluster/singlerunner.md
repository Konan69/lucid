# SingleRunner

Import `effect/cluster/SingleRunner`. Source `effect@4.0.2/src/cluster/SingleRunner.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 1. Module-name matches in Vivid: 0. No bare-name match.

## layer

Provides a SQL-backed single-node cluster for running durable entities and workflows.

Source: `effect@4.0.2/src/cluster/SingleRunner.ts:61`.

Vivid `SingleRunner.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: (options?: {
    readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined;
    readonly runnerStorage?: "memory" | "sql" | undefined;
}) => Layer.Layer<Sharding.Sharding | Runners.Runners | MessageStorage.MessageStorage, ConfigError, SqlClient.SqlClient | Crypto.Crypto>;
```
