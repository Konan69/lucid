# RunnerStorage

Import `effect/cluster/RunnerStorage`. Source `effect@4.0.2/src/cluster/RunnerStorage.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 5. Module-name matches in Vivid: 0. No bare-name match.

## RunnerStorage

Represents a generic interface to the persistent storage required by the cluster.

Source: `effect@4.0.2/src/cluster/RunnerStorage.ts:32`.

Vivid `RunnerStorage.RunnerStorage` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class RunnerStorage extends RunnerStorage_base {
}
```

## Encoded

String-encoded runner storage interface used by adapters that persist runner addresses, runners, machine ids, and shard ids outside the in-memory model.

Source: `effect@4.0.2/src/cluster/RunnerStorage.ts:93`.

Vivid `RunnerStorage.Encoded` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export interface Encoded {
    readonly getRunners: Effect.Effect<Array<readonly [
        runner: string,
        healthy: boolean
    ]>, PersistenceError>;
    readonly register: (address: string, runner: string, healthy: boolean) => Effect.Effect<number, PersistenceError>;
    readonly unregister: (address: string) => Effect.Effect<void, PersistenceError>;
    readonly setRunnerHealth: (address: string, healthy: boolean) => Effect.Effect<void, PersistenceError>;
    readonly acquire: (address: string, shardIds: NonEmptyArray<string>) => Effect.Effect<Array<string>, PersistenceError>;
    readonly refresh: (address: string, shardIds: Array<string>) => Effect.Effect<ReadonlyArray<string>, PersistenceError>;
    readonly release: (address: string, shardId: string) => Effect.Effect<void, PersistenceError>;
    readonly releaseAll: (address: string) => Effect.Effect<void, PersistenceError>;
}
```

## makeEncoded

Adapts an encoded runner storage implementation into `RunnerStorage`, converting runner addresses, runners, machine ids, and shard ids between typed values and their string or numeric storage forms.

Source: `effect@4.0.2/src/cluster/RunnerStorage.ts:155`.

Vivid `RunnerStorage.makeEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeEncoded: (encoded: Encoded) => {
    readonly register: (runner: Runner, healthy: boolean) => Effect.Effect<MachineId.MachineId, PersistenceError>;
    readonly unregister: (address: RunnerAddress) => Effect.Effect<void, PersistenceError>;
    readonly getRunners: Effect.Effect<Array<readonly [
        runner: Runner,
        healthy: boolean
    ]>, PersistenceError>;
    readonly setRunnerHealth: (address: RunnerAddress, healthy: boolean) => Effect.Effect<void, PersistenceError>;
    readonly acquire: (address: RunnerAddress, shardIds: Iterable<ShardId.ShardId>) => Effect.Effect<Array<ShardId.ShardId>, PersistenceError>;
    readonly refresh: (address: RunnerAddress, shardIds: Iterable<ShardId.ShardId>) => Effect.Effect<Array<ShardId.ShardId>, PersistenceError>;
    readonly release: (address: RunnerAddress, shardId: ShardId.ShardId) => Effect.Effect<void, PersistenceError>;
    readonly releaseAll: (address: RunnerAddress) => Effect.Effect<void, PersistenceError>;
};
```

## makeMemory

Creates an in-memory `RunnerStorage` implementation for tests and local use.

Source: `effect@4.0.2/src/cluster/RunnerStorage.ts:208`.

Vivid `RunnerStorage.makeMemory` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeMemory: Effect.Effect<{
    readonly register: (runner: Runner, healthy: boolean) => Effect.Effect<MachineId.MachineId, PersistenceError>;
    readonly unregister: (address: RunnerAddress) => Effect.Effect<void, PersistenceError>;
    readonly getRunners: Effect.Effect<Array<readonly [
        runner: Runner,
        healthy: boolean
    ]>, PersistenceError>;
    readonly setRunnerHealth: (address: RunnerAddress, healthy: boolean) => Effect.Effect<void, PersistenceError>;
    readonly acquire: (address: RunnerAddress, shardIds: Iterable<ShardId.ShardId>) => Effect.Effect<Array<ShardId.ShardId>, PersistenceError>;
    readonly refresh: (address: RunnerAddress, shardIds: Iterable<ShardId.ShardId>) => Effect.Effect<Array<ShardId.ShardId>, PersistenceError>;
    readonly release: (address: RunnerAddress, shardId: ShardId.ShardId) => Effect.Effect<void, PersistenceError>;
    readonly releaseAll: (address: RunnerAddress) => Effect.Effect<void, PersistenceError>;
}, never, never>;
```

## layerMemory

Layer that provides the in-memory `RunnerStorage` implementation.

Source: `effect@4.0.2/src/cluster/RunnerStorage.ts:245`.

Vivid `RunnerStorage.layerMemory` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerMemory: Layer.Layer<RunnerStorage>;
```
