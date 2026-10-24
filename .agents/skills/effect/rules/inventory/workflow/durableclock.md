# DurableClock

Import `effect/workflow/DurableClock`. Source `effect@4.0.2/src/workflow/DurableClock.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 3. Module-name matches in Vivid: 0. No bare-name match.

## DurableClock

Represents a durable workflow timer with a name, duration, and deferred completed when the timer wakes.

Source: `effect@4.0.2/src/workflow/DurableClock.ts:30`.

Vivid `DurableClock.DurableClock` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DurableClock {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly duration: Duration.Duration;
    readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>;
}
```

## make

Creates a durable clock definition and its associated deferred wake-up signal.

Source: `effect@4.0.2/src/workflow/DurableClock.ts:45`.

Vivid `DurableClock.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options: {
    readonly name: string;
    readonly duration: Duration.Input;
}) => DurableClock;
```

## sleep

Waits inside a workflow, using an in-memory activity for durations at or below the threshold and scheduling a durable clock for longer durations.

Source: `effect@4.0.2/src/workflow/DurableClock.ts:74`.

Vivid `DurableClock.sleep` matches: 0. No qualified match. Bare-name matches: 52. Aliased usage is unverified.

```ts
export declare const sleep: (options: {
    readonly name: string;
    readonly duration: Duration.Input;
    readonly inMemoryThreshold?: Duration.Input | undefined;
}) => Effect.Effect<void, never, WorkflowEngine | WorkflowInstance>;
```
