# Sharding

Import `effect/cluster/Sharding`. Source `effect@4.0.2/src/cluster/Sharding.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## Sharding

Service that registers entities and singletons, routes messages to owned shards, generates runner-local snowflake ids, and polls storage for persisted work.

Source: `effect@4.0.2/src/cluster/Sharding.ts:91`.

Vivid `Sharding.Sharding` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class Sharding extends Sharding_base {
}
```

## layer

Layer that constructs the `Sharding` service from sharding configuration, runner communication, message storage, runner storage, runner health, the snowflake generator, and the entity reaper.

Source: `effect@4.0.2/src/cluster/Sharding.ts:1846`.

Vivid `Sharding.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<Sharding, never, ShardingConfig | Runners | MessageStorage.MessageStorage | RunnerStorage | RunnerHealth.RunnerHealth>;
```
