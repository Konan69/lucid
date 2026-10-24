# RunnerHealth

Import `effect/cluster/RunnerHealth`. Source `effect@4.0.2/src/cluster/RunnerHealth.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 6. Module-name matches in Vivid: 0. No bare-name match.

## RunnerHealth

Represents the service used to check if a Runner is healthy.

Source: `effect@4.0.2/src/cluster/RunnerHealth.ts:35`.

Vivid `RunnerHealth.RunnerHealth` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class RunnerHealth extends RunnerHealth_base {
}
```

## layerNoop

Layer that always considers a runner healthy.

Source: `effect@4.0.2/src/cluster/RunnerHealth.ts:54`.

Vivid `RunnerHealth.layerNoop` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerNoop: Layer.Layer<RunnerHealth, never, never>;
```

## makePing

Creates a `RunnerHealth` service that pings runners through `Runners`, retrying failed pings on a short schedule and treating a successful ping within the timeout as healthy.

Source: `effect@4.0.2/src/cluster/RunnerHealth.ts:67`.

Vivid `RunnerHealth.makePing` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makePing: Effect.Effect<RunnerHealth["Service"], never, Runners.Runners | Scope.Scope>;
```

## layerPing

Layer that pings runners directly to check whether they are healthy.

Source: `effect@4.0.2/src/cluster/RunnerHealth.ts:93`.

Vivid `RunnerHealth.layerPing` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerPing: Layer.Layer<RunnerHealth, never, Runners.Runners>;
```

## makeK8s

Creates a `RunnerHealth` service that checks Kubernetes pod readiness for a runner host, optionally scoped by namespace and label selector.

Source: `effect@4.0.2/src/cluster/RunnerHealth.ts:111`.

Vivid `RunnerHealth.makeK8s` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeK8s: (options?: {
    readonly namespace?: string | undefined;
    readonly labelSelector?: string | undefined;
} | undefined) => Effect.Effect<{
    readonly isAlive: (address: RunnerAddress) => Effect.Effect<boolean>;
}, never, K8s.K8sHttpClient>;
```

## layerK8s

Layer that checks Kubernetes pod readiness to determine whether a runner is healthy.

Source: `effect@4.0.2/src/cluster/RunnerHealth.ts:143`.

Vivid `RunnerHealth.layerK8s` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerK8s: (options?: {
    readonly namespace?: string | undefined;
    readonly labelSelector?: string | undefined;
} | undefined) => Layer.Layer<RunnerHealth, never, K8s.K8sHttpClient>;
```
