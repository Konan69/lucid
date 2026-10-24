# SqlRunnerStorage

Import `effect/cluster/SqlRunnerStorage`. Source `effect@4.0.2/src/cluster/SqlRunnerStorage.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 3. Module-name matches in Vivid: 0. No bare-name match.

## make

Creates a SQL-backed `RunnerStorage` implementation for registered runners and shard locks, using the configured table prefix and advisory locks where supported and enabled.

Source: `effect@4.0.2/src/cluster/SqlRunnerStorage.ts:73`.

Vivid `SqlRunnerStorage.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options: {
    readonly prefix?: string | undefined;
}) => Effect.Effect<{
    readonly register: (runner: import("./Runner.ts").Runner, healthy: boolean) => Effect.Effect<import("./MachineId.ts").MachineId, PersistenceError>;
    readonly unregister: (address: import("./RunnerAddress.ts").RunnerAddress) => Effect.Effect<void, PersistenceError>;
    readonly getRunners: Effect.Effect<Array<readonly [
        runner: import("./Runner.ts").Runner,
        healthy: boolean
    ]>, PersistenceError>;
    readonly setRunnerHealth: (address: import("./RunnerAddress.ts").RunnerAddress, healthy: boolean) => Effect.Effect<void, PersistenceError>;
    readonly acquire: (address: import("./RunnerAddress.ts").RunnerAddress, shardIds: Iterable<ShardId.ShardId>) => Effect.Effect<Array<ShardId.ShardId>, PersistenceError>;
    readonly refresh: (address: import("./RunnerAddress.ts").RunnerAddress, shardIds: Iterable<ShardId.ShardId>) => Effect.Effect<Array<ShardId.ShardId>, PersistenceError>;
    readonly release: (address: import("./RunnerAddress.ts").RunnerAddress, shardId: ShardId.ShardId) => Effect.Effect<void, PersistenceError>;
    readonly releaseAll: (address: import("./RunnerAddress.ts").RunnerAddress) => Effect.Effect<void, PersistenceError>;
}, SqlError, Scope.Scope | ShardingConfig.ShardingConfig | SqlClient.SqlClient>;
```

## layer

Layer that provides SQL-backed `RunnerStorage` using the default table prefix.

Source: `effect@4.0.2/src/cluster/SqlRunnerStorage.ts:774`.

Vivid `SqlRunnerStorage.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<RunnerStorage.RunnerStorage, SqlError, SqlClient.SqlClient | ShardingConfig.ShardingConfig>;
```

## layerWith

Layer that provides SQL-backed `RunnerStorage` using a custom table prefix.

Source: `effect@4.0.2/src/cluster/SqlRunnerStorage.ts:787`.

Vivid `SqlRunnerStorage.layerWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerWith: (options: {
    readonly prefix?: string | undefined;
}) => Layer.Layer<RunnerStorage.RunnerStorage, SqlError, SqlClient.SqlClient | ShardingConfig.ShardingConfig>;
```
