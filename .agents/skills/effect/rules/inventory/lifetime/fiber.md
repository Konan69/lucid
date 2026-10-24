# Fiber

Import `effect/Fiber`. Source `effect@4.0.2/src/Fiber.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 12. Module-name matches in Vivid: 292. apps/desktop/scripts/control.ts:7, apps/desktop/scripts/control.ts:184, apps/desktop/scripts/control.ts:246

## Fiber

The Fiber namespace contains utility types and functions for working with fibers. It provides type-level utilities for fiber operations and variance encoding.

Source: `effect@4.0.2/src/Fiber.ts:127`.

Vivid `Fiber.Fiber` matches: 13. apps/desktop/src/main/signin.ts:389, apps/desktop/src/main/turn.ts:137, apps/server/src/code/process.test.ts:33 Bare-name matches: 292. Aliased usage is unverified.

```ts
export interface Fiber<out A, out E = never> extends Pipeable {
    readonly [TypeId]: Fiber.Variance<A, E>;
    readonly id: number;
    readonly currentOpCount: number;
    readonly getRef: <A>(ref: Context.Reference<A>) => A;
    readonly context: Context.Context<never>;
    setContext(context: Context.Context<never>): void;
    readonly cache: Fiber.Cache;
    readonly currentDispatcher: SchedulerDispatcher;
    readonly addObserver: (cb: (exit: Exit<A, E>) => void) => () => void;
    readonly interruptUnsafe: (fiberId?: number | undefined, annotations?: Context.Context<never> | undefined) => void;
    readonly pollUnsafe: () => Exit<A, E> | undefined;
}
export declare namespace Fiber {
    interface Variance<out A, out E = never> {
        readonly _A: Covariant<A>;
        readonly _E: Covariant<E>;
    }
    interface Cache {
        readonly scheduler: Scheduler;
        readonly tracer: Tracer | undefined;
        readonly tracerContext: Tracer["context"] | undefined;
        readonly tracerEnabled: boolean;
        readonly span: AnySpan | undefined;
        readonly logLevel: LogLevel;
        readonly minimumLogLevel: LogLevel;
        readonly stackFrame: StackFrame | undefined;
        readonly runtimeMetrics: FiberRuntimeMetricsService | undefined;
        readonly maxOpsBeforeYield: number;
        readonly preventYield: boolean;
    }
}
```

## await

Waits for a fiber to complete and returns its exit value.

Source: `effect@4.0.2/src/Fiber.ts:226`.

Vivid `Fiber.await` matches: 20. apps/server/src/computers/device.test.ts:529, apps/server/src/computers/device.test.ts:633, apps/server/src/computers/device.test.ts:818 Bare-name matches: 395. Aliased usage is unverified.

```ts
declare const await_: <A, E>(self: Fiber<A, E>) => Effect<Exit<A, E>>;
export { await_ as await };
```

## awaitAll

Waits for all fibers in the provided iterable to complete and returns an array of their exit values.

Source: `effect@4.0.2/src/Fiber.ts:265`.

Vivid `Fiber.awaitAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const awaitAll: <A extends Fiber<any, any>>(self: Iterable<A>) => Effect<Array<Exit<A extends Fiber<infer _A, infer _E> ? _A : never, A extends Fiber<infer _A, infer _E> ? _E : never>>>;
```

## join

Joins a fiber, blocking until it completes. If the fiber succeeds, returns its value. If it fails, the error is propagated.

Source: `effect@4.0.2/src/Fiber.ts:310`.

Vivid `Fiber.join` matches: 173. apps/desktop/scripts/control.ts:184, apps/desktop/scripts/control.ts:246, apps/desktop/src/main/computer.test.ts:190 Bare-name matches: 601. Aliased usage is unverified.

```ts
export declare const join: <A, E>(self: Fiber<A, E>) => Effect<A, E>;
```

## joinAll

Waits for all fibers to succeed and returns their values in input order.

Source: `effect@4.0.2/src/Fiber.ts:337`.

Vivid `Fiber.joinAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const joinAll: <A extends Iterable<Fiber<any, any>>>(self: A) => Effect<Arr.ReadonlyArray.With<A, A extends Iterable<Fiber<infer _A, infer _E>> ? _A : never>, A extends Iterable<Fiber<infer _A, infer _E>> ? _E : never>;
```

## interrupt

Interrupts a fiber, causing it to stop executing and clean up any acquired resources.

Source: `effect@4.0.2/src/Fiber.ts:387`.

Vivid `Fiber.interrupt` matches: 30. apps/desktop/src/main/egress.test.ts:515, apps/desktop/src/main/egress.test.ts:740, apps/desktop/src/main/signin.ts:432 Bare-name matches: 43. Aliased usage is unverified.

```ts
export declare const interrupt: <A, E>(self: Fiber<A, E>) => Effect<void>;
```

## interruptAs

Interrupts a fiber with a specific fiber ID as the interruptor. This allows tracking which fiber initiated the interruption.

Source: `effect@4.0.2/src/Fiber.ts:430`.

Vivid `Fiber.interruptAs` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interruptAs: {
    (fiberId: number | undefined, annotations?: Context.Context<never> | undefined): <A, E>(self: Fiber<A, E>) => Effect<void>;
    <A, E>(self: Fiber<A, E>, fiberId: number | undefined, annotations?: Context.Context<never> | undefined): Effect<void>;
};
```

## interruptAll

Interrupts all fibers in the provided iterable, causing them to stop executing and clean up any acquired resources.

Source: `effect@4.0.2/src/Fiber.ts:564`.

Vivid `Fiber.interruptAll` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interruptAll: <A extends Iterable<Fiber<any, any>>>(fibers: A) => Effect<void>;
```

## interruptAllAs

Interrupts all fibers in the provided iterable using the specified fiber ID as the interrupting fiber. This allows you to control which fiber is considered the source of the interruption, which can be useful for debugging and tracing.

Source: `effect@4.0.2/src/Fiber.ts:612`.

Vivid `Fiber.interruptAllAs` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const interruptAllAs: {
    (fiberId: number): <A extends Iterable<Fiber<any, any>>>(fibers: A) => Effect<void>;
    <A extends Iterable<Fiber<any, any>>>(fibers: A, fiberId: number): Effect<void>;
};
```

## isFiber

Checks whether a value is a Fiber. This is a type guard that can be used to determine if an unknown value is a Fiber instance.

Source: `effect@4.0.2/src/Fiber.ts:740`.

Vivid `Fiber.isFiber` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isFiber: (u: unknown) => u is Fiber<unknown, unknown>;
```

## getCurrent

Returns the current fiber if called from within a fiber context, otherwise returns `undefined`.

Source: `effect@4.0.2/src/Fiber.ts:776`.

Vivid `Fiber.getCurrent` matches: 2. packages/agent/runtime/src/notes.test.ts:299, packages/agent/runtime/src/notes.test.ts:301 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const getCurrent: () => Fiber<any, any> | undefined;
```

## runIn

Adds a fiber to a `Scope` and returns the same fiber.

Source: `effect@4.0.2/src/Fiber.ts:801`.

Vivid `Fiber.runIn` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const runIn: {
    (scope: Scope): <A, E>(self: Fiber<A, E>) => Fiber<A, E>;
    <A, E>(self: Fiber<A, E>, scope: Scope): Fiber<A, E>;
};
```
