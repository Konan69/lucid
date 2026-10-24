# EntityAddress

Import `effect/cluster/EntityAddress`. Source `effect@4.0.2/src/cluster/EntityAddress.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## EntityAddress

Represents the unique address of an entity within the cluster.

Source: `effect@4.0.2/src/cluster/EntityAddress.ts:26`.

Vivid `EntityAddress.EntityAddress` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class EntityAddress extends EntityAddress_base {
    readonly [TypeId] = "~effect/cluster/EntityAddress";
    toString(): string;
    [Equal.symbol](that: EntityAddress): boolean;
    [Hash.symbol](): number;
}
```

## make

Constructs an `EntityAddress` from a shard ID, entity type, and entity ID.

Source: `effect@4.0.2/src/cluster/EntityAddress.ts:96`.

Vivid `EntityAddress.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options: {
    readonly shardId: ShardId;
    readonly entityType: EntityType;
    readonly entityId: EntityId;
}) => EntityAddress;
```
