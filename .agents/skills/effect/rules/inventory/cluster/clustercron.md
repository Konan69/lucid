# ClusterCron

Import `effect/cluster/ClusterCron`. Source `effect@4.0.2/src/cluster/ClusterCron.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 1. Module-name matches in Vivid: 0. No bare-name match.

## make

Creates a layer that runs a cron job through the cluster sharding system.

Source: `effect@4.0.2/src/cluster/ClusterCron.ts:45`.

Vivid `ClusterCron.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <E, R>(options: {
    readonly name: string;
    readonly cron: Cron.Cron;
    readonly execute: Effect.Effect<void, E, R>;
    readonly shardGroup?: string | undefined;
    readonly calculateNextRunFromPrevious?: boolean | undefined;
    readonly skipIfOlderThan?: Duration.Input | undefined;
}) => Layer.Layer<never, never, Sharding | Exclude<R, Scope>>;
```
