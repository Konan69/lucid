# EntityId

Import `effect/cluster/EntityId`. Source `effect@4.0.2/src/cluster/EntityId.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## EntityId

Branded string type representing the ID of an entity instance.

Source: `effect@4.0.2/src/cluster/EntityId.ts:28`.

Vivid `EntityId.EntityId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const EntityId: Schema.brand<Schema.String, "~effect/cluster/EntityId">;
export type EntityId = typeof EntityId.Type;
```

## make

Brands a string as an `EntityId`.

Source: `effect@4.0.2/src/cluster/EntityId.ts:54`.

Vivid `EntityId.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (id: string) => EntityId;
```
