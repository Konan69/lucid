# EntityResource

Import `effect/cluster/EntityResource`. Source `effect@4.0.2/src/cluster/EntityResource.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 5. Module-name matches in Vivid: 0. No bare-name match.

## TypeId

Literal type of the `EntityResource` type identifier.

Source: `effect@4.0.2/src/cluster/EntityResource.ts:41`.

Vivid `EntityResource.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const TypeId: TypeId;
export type TypeId = "~effect/cluster/EntityResource";
```

## EntityResource

A resource acquired inside a cluster entity and kept alive across restarts.

Source: `effect@4.0.2/src/cluster/EntityResource.ts:55`.

Vivid `EntityResource.EntityResource` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EntityResource<out A, out E = never> {
    readonly [TypeId]: TypeId;
    readonly get: Effect.Effect<A, E, Scope.Scope>;
    readonly close: Effect.Effect<void>;
}
```

## CloseScope

Context service for a Scope that is only closed when the resource is explicitly closed.

Source: `effect@4.0.2/src/cluster/EntityResource.ts:77`.

Vivid `EntityResource.CloseScope` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class CloseScope extends CloseScope_base {
}
```

## make

Creates an `EntityResource` that can be acquired inside a cluster entity.

Source: `effect@4.0.2/src/cluster/EntityResource.ts:104`.

Vivid `EntityResource.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A, E, R>(options: {
    readonly acquire: Effect.Effect<A, E, R>;
    readonly idleTimeToLive?: Duration.Input | undefined;
    readonly acquireEagerly?: boolean | undefined;
}) => Effect.Effect<EntityResource<A, E>, E, Scope.Scope | Exclude<R, CloseScope> | Sharding | Entity.CurrentAddress>;
```

## makeK8sPod

Creates an `EntityResource` backed by a Kubernetes Pod.

Source: `effect@4.0.2/src/cluster/EntityResource.ts:169`.

Vivid `EntityResource.makeK8sPod` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeK8sPod: (spec: K8sPod, options?: {
    readonly idleTimeToLive?: Duration.Input | undefined;
} | undefined) => Effect.Effect<EntityResource<K8sHttpClient.PodStatus>, never, Scope.Scope | Sharding | Entity.CurrentAddress | K8sHttpClient.K8sHttpClient>;
```
