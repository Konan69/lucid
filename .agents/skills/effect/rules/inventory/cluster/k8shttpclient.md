# K8sHttpClient

Import `effect/cluster/K8sHttpClient`. Source `effect@4.0.2/src/cluster/K8sHttpClient.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 6. Module-name matches in Vivid: 0. No bare-name match.

## K8sHttpClient

Service tag for the HTTP client used to call the Kubernetes API.

Source: `effect@4.0.2/src/cluster/K8sHttpClient.ts:32`.

Vivid `K8sHttpClient.K8sHttpClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class K8sHttpClient extends K8sHttpClient_base {
}
```

## layer

Layer that configures `K8sHttpClient` for the in-cluster Kubernetes API.

Source: `effect@4.0.2/src/cluster/K8sHttpClient.ts:50`.

Vivid `K8sHttpClient.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<K8sHttpClient, never, HttpClient.HttpClient | FileSystem.FileSystem>;
```

## makeGetPods

Creates a cached effect that fetches running Kubernetes pods.

Source: `effect@4.0.2/src/cluster/K8sHttpClient.ts:94`.

Vivid `K8sHttpClient.makeGetPods` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeGetPods: (options?: {
    readonly namespace?: string | undefined;
    readonly labelSelector?: string | undefined;
} | undefined) => Effect.Effect<Effect.Effect<Map<string, Pod>, HttpClientError.HttpClientError | Schema.SchemaError, never>, never, K8sHttpClient>;
```

## makeCreatePod

Creates a scoped function that ensures a Kubernetes pod exists and waits until it is ready.

Source: `effect@4.0.2/src/cluster/K8sHttpClient.ts:144`.

Vivid `K8sHttpClient.makeCreatePod` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeCreatePod: Effect.Effect<(spec: K8sPod) => Effect.Effect<PodStatus, never, import("../Scope.ts").Scope>, never, K8sHttpClient>;
```

## PodStatus

Schema for the subset of Kubernetes Pod status used by cluster helpers.

Source: `effect@4.0.2/src/cluster/K8sHttpClient.ts:249`.

Vivid `K8sHttpClient.PodStatus` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class PodStatus extends PodStatus_base {
}
```

## Pod

Schema for Kubernetes Pod values used by cluster helpers.

Source: `effect@4.0.2/src/cluster/K8sHttpClient.ts:271`.

Vivid `K8sHttpClient.Pod` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare class Pod extends Pod_base {
    get isReady(): boolean;
    get isReadyOrInitializing(): boolean;
}
```
