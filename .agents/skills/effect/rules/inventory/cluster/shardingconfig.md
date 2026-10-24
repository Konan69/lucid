# ShardingConfig

Import `effect/cluster/ShardingConfig`. Source `effect@4.0.2/src/cluster/ShardingConfig.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 8. Module-name matches in Vivid: 0. No bare-name match.

## ShardingConfig

Represents the configuration for the `Sharding` service on a given runner.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:31`.

Vivid `ShardingConfig.ShardingConfig` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class ShardingConfig extends ShardingConfig_base {
}
```

## defaults

Default values for `ShardingConfig`, including the default local runner address, shard group, shard count, mailbox settings, polling intervals, and remote serialization simulation.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:179`.

Vivid `ShardingConfig.defaults` matches: 0. No qualified match. Bare-name matches: 44. Aliased usage is unverified.

```ts
export declare const defaults: ShardingConfig["Service"];
```

## layer

Creates a `ShardingConfig` layer by merging the provided partial options over `defaults`.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:235`.

Vivid `ShardingConfig.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: (options?: Partial<ShardingConfig["Service"]>) => Layer.Layer<ShardingConfig>;
```

## layerDefaults

Layer that provides the default `ShardingConfig` values.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:245`.

Vivid `ShardingConfig.layerDefaults` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerDefaults: Layer.Layer<ShardingConfig>;
```

## config

Describes how to load `ShardingConfig` values, applying the same defaults used by the in-memory `defaults` object.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:255`.

Vivid `ShardingConfig.config` matches: 0. No qualified match. Bare-name matches: 246. Aliased usage is unverified.

```ts
export declare const config: Config.Config<ShardingConfig["Service"]>;
```

## configFromEnv

Effect that loads `ShardingConfig` from environment variables using the constant-case config provider.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:373`.

Vivid `ShardingConfig.configFromEnv` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const configFromEnv: Effect.Effect<{
    readonly runnerAddress: Option.Option<RunnerAddress>;
    readonly runnerListenAddress: Option.Option<RunnerAddress>;
    readonly runnerShardWeight: number;
    readonly availableShardGroups: ReadonlyArray<string>;
    readonly assignedShardGroups: ReadonlyArray<string>;
    readonly shardsPerGroup: number;
    readonly shardLockRefreshInterval: Duration.Input;
    readonly shardLockExpiration: Duration.Input;
    readonly shardLockDisableAdvisory: boolean;
    readonly preemptiveShutdown: boolean;
    readonly entityMailboxCapacity: number | "unbounded";
    readonly maxResidentEntities: number | "unbounded";
    readonly unprocessedMessageBatchSize: number;
    readonly entityMaxIdleTime: Duration.Input;
    readonly entityRegistrationTimeout: Duration.Input;
    readonly entityTerminationTimeout: Duration.Input;
    readonly entityMessagePollInterval: Duration.Input;
    readonly entityReplyPollInterval: Duration.Input;
    readonly refreshAssignmentsInterval: Duration.Input;
    readonly sendRetryInterval: Duration.Input;
    readonly runnerHealthCheckInterval: Duration.Input;
    readonly simulateRemoteSerialization: boolean;
}, Config.ConfigError, never>;
```

## layerFromEnv

Layer that loads `ShardingConfig` from environment variables and, when options are provided, overlays those options on top of the loaded values.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:390`.

Vivid `ShardingConfig.layerFromEnv` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerFromEnv: (options?: Partial<ShardingConfig["Service"]> | undefined) => Layer.Layer<ShardingConfig, Config.ConfigError>;
```

## shardGroupConfig

Normalizes the provided `ShardingConfig` to calculate the `available` and `assigned` shard groups.

Source: `effect@4.0.2/src/cluster/ShardingConfig.ts:406`.

Vivid `ShardingConfig.shardGroupConfig` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const shardGroupConfig: (config: ShardingConfig["Service"]) => {
    readonly available: ReadonlySet<string>;
    readonly assigned: ReadonlySet<string>;
};
```
