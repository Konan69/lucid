# Singleton

Import `effect/cluster/Singleton`. Source `effect@4.0.2/src/cluster/Singleton.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 1. Module-name matches in Vivid: 0. No bare-name match.

## make

Creates a layer that registers a singleton effect with `Sharding` under the specified name and optional shard group.

Source: `effect@4.0.2/src/cluster/Singleton.ts:48`.

Vivid `Singleton.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <E, R>(name: string, run: Effect.Effect<void, E, R>, options?: {
    readonly shardGroup?: string | undefined;
}) => Layer.Layer<never, never, Sharding | Exclude<R, Scope>>;
```
