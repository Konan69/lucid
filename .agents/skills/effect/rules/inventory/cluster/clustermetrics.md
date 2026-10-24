# ClusterMetrics

Import `effect/cluster/ClusterMetrics`. Source `effect@4.0.2/src/cluster/ClusterMetrics.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 5. Module-name matches in Vivid: 0. No bare-name match.

## entities

Creates a gauge tracking the number of active entity instances for each entity type on the current runner.

Source: `effect@4.0.2/src/cluster/ClusterMetrics.ts:41`.

Vivid `ClusterMetrics.entities` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const entities: Metric.Gauge<bigint>;
```

## singletons

Creates a gauge tracking the number of singleton processes currently running on the current runner.

Source: `effect@4.0.2/src/cluster/ClusterMetrics.ts:51`.

Vivid `ClusterMetrics.singletons` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const singletons: Metric.Gauge<bigint>;
```

## runners

Represents a gauge tracking the number of registered cluster runners.

Source: `effect@4.0.2/src/cluster/ClusterMetrics.ts:70`.

Vivid `ClusterMetrics.runners` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runners: Metric.Gauge<bigint>;
```

## runnersHealthy

Represents a gauge tracking the number of cluster runners currently considered healthy.

Source: `effect@4.0.2/src/cluster/ClusterMetrics.ts:94`.

Vivid `ClusterMetrics.runnersHealthy` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runnersHealthy: Metric.Gauge<bigint>;
```

## shards

Represents a gauge tracking the number of shards currently acquired by the current runner.

Source: `effect@4.0.2/src/cluster/ClusterMetrics.ts:118`.

Vivid `ClusterMetrics.shards` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const shards: Metric.Gauge<bigint>;
```
