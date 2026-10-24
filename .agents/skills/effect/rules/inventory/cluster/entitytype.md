# EntityType

Import `effect/cluster/EntityType`. Source `effect@4.0.2/src/cluster/EntityType.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## EntityType

Branded string type representing an entity type name.

Source: `effect@4.0.2/src/cluster/EntityType.ts:28`.

Vivid `EntityType.EntityType` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const EntityType: Schema.brand<Schema.String, "~effect/cluster/EntityType">;
export type EntityType = typeof EntityType.Type;
```

## make

Brands a string as an `EntityType`.

Source: `effect@4.0.2/src/cluster/EntityType.ts:56`.

Vivid `EntityType.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (value: string) => EntityType;
```
