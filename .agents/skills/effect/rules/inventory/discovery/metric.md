# Metric

Import `effect/Metric`. Source `effect@4.0.2/src/Metric.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 5. Module-name matches in Vivid: 0. No bare-name match.

## CounterState

State interface for Counter metrics containing the current count and increment mode.

Source: `effect@4.0.2/src/Metric.ts:253`.

Vivid `Metric.CounterState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface CounterState<in Input extends number | bigint> {
    readonly count: Input extends bigint ? bigint : number;
    readonly incremental: boolean;
}
```

## FrequencyState

State interface for Frequency metrics containing occurrence counts for discrete string values.

Source: `effect@4.0.2/src/Metric.ts:413`.

Vivid `Metric.FrequencyState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface FrequencyState {
    readonly occurrences: ReadonlyMap<string, number>;
}
```

## GaugeState

State interface for Gauge metrics containing the current instantaneous value.

Source: `effect@4.0.2/src/Metric.ts:544`.

Vivid `Metric.GaugeState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface GaugeState<in Input extends number | bigint> {
    readonly value: Input extends bigint ? bigint : number;
}
```

## HistogramState

State interface for Histogram metrics containing bucket distributions and aggregate statistics.

Source: `effect@4.0.2/src/Metric.ts:721`.

Vivid `Metric.HistogramState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface HistogramState {
    readonly buckets: ReadonlyArray<[
        number,
        number
    ]>;
    readonly count: number;
    readonly min: number;
    readonly max: number;
    readonly sum: number;
}
```

## SummaryState

State interface for Summary metrics containing quantile calculations and aggregate statistics.

Source: `effect@4.0.2/src/Metric.ts:910`.

Vivid `Metric.SummaryState` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SummaryState {
    readonly quantiles: ReadonlyArray<readonly [
        number,
        number | undefined
    ]>;
    readonly count: number;
    readonly min: number;
    readonly max: number;
    readonly sum: number;
}
```
