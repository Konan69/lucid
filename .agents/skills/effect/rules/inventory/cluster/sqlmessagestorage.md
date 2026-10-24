# SqlMessageStorage

Import `effect/cluster/SqlMessageStorage`. Source `effect@4.0.2/src/cluster/SqlMessageStorage.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## makeEncoded

Creates a SQL-backed encoded message storage driver, running its migrations and using the optional table prefix.

Source: `effect@4.0.2/src/cluster/SqlMessageStorage.ts:70`.

Vivid `SqlMessageStorage.makeEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeEncoded: (options?: {
    readonly prefix?: string | undefined;
}) => Effect.Effect<MessageStorage.Encoded, never, SqlClient.SqlClient | Crypto.Crypto>;
```

## make

Creates a SQL-backed `MessageStorage` implementation, running its migrations and using the optional table prefix.

Source: `effect@4.0.2/src/cluster/SqlMessageStorage.ts:804`.

Vivid `SqlMessageStorage.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options?: {
    readonly prefix?: string | undefined;
}) => Effect.Effect<MessageStorage.MessageStorage["Service"], never, SqlClient.SqlClient | Snowflake.Generator | Crypto.Crypto>;
```

## layer

Layer that provides SQL-backed `MessageStorage` using the default table prefix and the default snowflake generator.

Source: `effect@4.0.2/src/cluster/SqlMessageStorage.ts:842`.

Vivid `SqlMessageStorage.layer` matches: 0. No qualified match. Bare-name matches: 555. Aliased usage is unverified.

```ts
export declare const layer: Layer.Layer<MessageStorage.MessageStorage, never, SqlClient.SqlClient | ShardingConfig | Crypto.Crypto>;
```

## layerWith

Layer that provides SQL-backed `MessageStorage` using a custom table prefix.

Source: `effect@4.0.2/src/cluster/SqlMessageStorage.ts:857`.

Vivid `SqlMessageStorage.layerWith` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerWith: (options: {
    readonly prefix?: string | undefined;
}) => Layer.Layer<MessageStorage.MessageStorage, never, SqlClient.SqlClient | ShardingConfig | Crypto.Crypto>;
```
