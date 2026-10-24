# ShardId

Import `effect/cluster/ShardId`. Source `effect@4.0.2/src/cluster/ShardId.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 6. Module-name matches in Vivid: 0. No bare-name match.

## ShardId

Schema for shard identifiers encoded as `{ group, id }` objects and decoded via `make`.

Source: `effect@4.0.2/src/cluster/ShardId.ts:51`.

Vivid `ShardId.ShardId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ShardId extends Equal.Equal, Hash.Hash, PrimaryKey.PrimaryKey {
    readonly [TypeId]: typeof TypeId;
    readonly group: string;
    readonly id: number;
}
export declare const ShardId: S.declare<ShardId, ShardId>;
```

## isShardId

Returns `true` when the value carries the `ShardId` runtime marker.

Source: `effect@4.0.2/src/cluster/ShardId.ts:41`.

Vivid `ShardId.isShardId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isShardId: (u: unknown) => u is ShardId;
```

## make

Creates or reuses the cached `ShardId` for the specified shard group and numeric id.

Source: `effect@4.0.2/src/cluster/ShardId.ts:95`.

Vivid `ShardId.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (group: string, id: number) => ShardId;
```

## toString

Formats a shard identifier as `group:id`.

Source: `effect@4.0.2/src/cluster/ShardId.ts:137`.

Vivid `ShardId.toString` matches: 0. No qualified match. Bare-name matches: 90. Aliased usage is unverified.

```ts
export declare const toString: (shardId: {
    readonly group: string;
    readonly id: number;
}) => string;
```

## fromStringEncoded

Parses a `group:id` string into plain shard id parts.

Source: `effect@4.0.2/src/cluster/ShardId.ts:155`.

Vivid `ShardId.fromStringEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare function fromStringEncoded(s: string): {
    readonly group: string;
    readonly id: number;
};
```

## fromString

Parses a `group:id` string into a cached `ShardId`.

Source: `effect@4.0.2/src/cluster/ShardId.ts:183`.

Vivid `ShardId.fromString` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare function fromString(s: string): ShardId;
```
