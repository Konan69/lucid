# MessageStorage

Import `effect/cluster/MessageStorage`. Source `effect@4.0.2/src/cluster/MessageStorage.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 14. Module-name matches in Vivid: 0. No bare-name match.

## MessageStorage

Service for cluster mailbox persistence and reply delivery.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:54`.

Vivid `MessageStorage.MessageStorage` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class MessageStorage extends MessageStorage_base {
}
```

## SaveResult

Variants and helper types for `SaveResult`.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:256`.

Vivid `MessageStorage.SaveResult` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type SaveResult<R extends Rpc.Any> = SaveResult.Success | SaveResult.Duplicate<R>;
export declare const SaveResult: {
    readonly $is: <Tag extends "Duplicate" | "Success">(tag: Tag) => {
        <T extends Data.TaggedEnum.Kind<SaveResult.Constructor, any, any, any, any>>(u: T): u is T & {
            readonly _tag: Tag;
        };
        (u: unknown): u is Extract<SaveResult.Duplicate<never>, {
            readonly _tag: Tag;
        }> | Extract<SaveResult.Success, {
            readonly _tag: Tag;
        }>;
    };
    readonly $match: {
        <A, B, C, D, Cases extends {
            readonly [Tag in "Duplicate" | "Success"]: (args: Extract<Data.TaggedEnum.Kind<SaveResult.Constructor, A, B, C, D>, {
                readonly _tag: Tag;
            }>) => any;
        }>(cases: Cases): (self: SaveResult<A extends Rpc.Any ? A : never>) => import("../Unify.ts").Unify<ReturnType<Cases["Duplicate" | "Success"]>>;
        <A, B, C, D, Cases extends {
            readonly [Tag in "Duplicate" | "Success"]: (args: Extract<Data.TaggedEnum.Kind<SaveResult.Constructor, A, B, C, D>, {
                readonly _tag: Tag;
            }>) => any;
        }>(self: SaveResult<A extends Rpc.Any ? A : never>, cases: Cases): import("../Unify.ts").Unify<ReturnType<Cases["Duplicate" | "Success"]>>;
    };
    readonly Duplicate: <A>(args: {
        readonly originalId: Snowflake.Snowflake;
        readonly lastReceivedReply: Option.Option<Reply.Reply<A extends Rpc.Any ? A : never>>;
    }) => SaveResult.Duplicate<A extends Rpc.Any ? A : never>;
    readonly Success: <A>(args: void) => SaveResult.Success;
};
export declare namespace SaveResult {
    type Encoded = SaveResult.Success | SaveResult.DuplicateEncoded;
    interface Success {
        readonly _tag: "Success";
    }
    interface Duplicate<R extends Rpc.Any> {
        readonly _tag: "Duplicate";
        readonly originalId: Snowflake.Snowflake;
        readonly lastReceivedReply: Option.Option<Reply.Reply<R>>;
    }
    interface DuplicateEncoded {
        readonly _tag: "Duplicate";
        readonly originalId: Snowflake.Snowflake;
        readonly lastReceivedReply: Option.Option<Reply.Encoded>;
    }
    interface Constructor extends Data.TaggedEnum.WithGenerics<1> {
        readonly taggedEnum: SaveResult<this["A"] extends Rpc.Any ? this["A"] : never>;
    }
}
```

## SaveResultEncoded

Constructors and matchers for encoded save results returned by storage drivers.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:248`.

Vivid `MessageStorage.SaveResultEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const SaveResultEncoded: {
    readonly $is: <Tag extends "Duplicate" | "Success">(tag: Tag) => (u: unknown) => u is Extract<SaveResult.DuplicateEncoded, {
        readonly _tag: Tag;
    }> | Extract<SaveResult.Success, {
        readonly _tag: Tag;
    }>;
    readonly $match: {
        <Cases extends {
            readonly [Tag in "Duplicate" | "Success"]: (args: Extract<SaveResult.Encoded, {
                readonly _tag: Tag;
            }>) => any;
        }>(cases: Cases): (value: SaveResult.Encoded) => import("../Unify.ts").Unify<ReturnType<Cases["Duplicate" | "Success"]>>;
        <Cases extends {
            readonly [Tag in "Duplicate" | "Success"]: (args: Extract<SaveResult.Encoded, {
                readonly _tag: Tag;
            }>) => any;
        }>(value: SaveResult.Encoded, cases: Cases): import("../Unify.ts").Unify<ReturnType<Cases["Duplicate" | "Success"]>>;
    };
    readonly Duplicate: Data.TaggedEnum.ConstructorFrom<SaveResult.DuplicateEncoded, "_tag">;
    readonly Success: Data.TaggedEnum.ConstructorFrom<SaveResult.Success, "_tag">;
};
```

## Encoded

Low-level storage-driver contract for encoded envelopes and replies.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:342`.

Vivid `MessageStorage.Encoded` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export type Encoded = {
    readonly saveEnvelope: (options: {
        readonly envelope: Envelope.Encoded;
        readonly primaryKey: string | null;
        readonly deliverAt: number | null;
    }) => Effect.Effect<SaveResult.Encoded, PersistenceError>;
    readonly saveReply: (reply: Reply.Encoded) => Effect.Effect<void, PersistenceError>;
    readonly clearReplies: (requestId: Snowflake.Snowflake, options?: {
        readonly expectedReplyId?: Snowflake.Snowflake | undefined;
    }) => Effect.Effect<void, PersistenceError>;
    readonly requestIdForPrimaryKey: (primaryKey: string) => Effect.Effect<Option.Option<Snowflake.Snowflake>, PersistenceError>;
    readonly repliesFor: (requestIds: Arr.NonEmptyArray<string>) => Effect.Effect<Array<Reply.Encoded>, PersistenceError>;
    readonly repliesForUnfiltered: (requestIds: Arr.NonEmptyArray<string>) => Effect.Effect<Array<Reply.Encoded>, PersistenceError>;
    readonly unprocessedMessages: (shardIds: Arr.NonEmptyArray<string>, now: number, options?: {
        readonly limit?: number | undefined;
        readonly addresses?: ReadonlyArray<EntityAddress> | undefined;
    } | undefined) => Effect.Effect<Array<{
        readonly envelope: Envelope.Encoded;
        readonly lastSentReply: Option.Option<Reply.Encoded>;
    }>, PersistenceError>;
    readonly unprocessedMessagesById: (messageIds: Arr.NonEmptyArray<Snowflake.Snowflake>, now: number) => Effect.Effect<Array<{
        readonly envelope: Envelope.Encoded;
        readonly lastSentReply: Option.Option<Reply.Encoded>;
    }>, PersistenceError>;
    readonly resetRequests: (requestIds: ReadonlyArray<Snowflake.Snowflake>) => Effect.Effect<void, PersistenceError>;
    readonly resetAddresses: (addresses: ReadonlyArray<EntityAddress>) => Effect.Effect<void, PersistenceError>;
    readonly clearAddress: (address: EntityAddress) => Effect.Effect<void, PersistenceError>;
    readonly resetShards: (shardIds: Arr.NonEmptyArray<string>) => Effect.Effect<void, PersistenceError>;
    readonly withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};
```

## EncodedUnprocessedOptions

Cursor options for reading encoded unprocessed messages across shard sets.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:492`.

Vivid `MessageStorage.EncodedUnprocessedOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type EncodedUnprocessedOptions<A> = {
    readonly existingShards: Array<number>;
    readonly newShards: Array<number>;
    readonly cursor: Option.Option<A>;
};
```

## EncodedRepliesOptions

Cursor options for reading encoded replies across request sets.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:510`.

Vivid `MessageStorage.EncodedRepliesOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type EncodedRepliesOptions<A> = {
    readonly existingRequests: Array<string>;
    readonly newRequests: Array<string>;
    readonly cursor: Option.Option<A>;
};
```

## make

Wraps a concrete message storage implementation with reply-handler management.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:528`.

Vivid `MessageStorage.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (storage: Omit<MessageStorage["Service"], "saveReply" | "registerReplyHandler" | "unregisterReplyHandler" | "unregisterShardReplyHandlers"> & {
    readonly saveReply: <R extends Rpc.Any>(reply: Reply.ReplyWithContext<R>) => Effect.Effect<Reply.ReplyWithContext<R>, PersistenceError | MalformedMessage>;
}) => Effect.Effect<MessageStorage["Service"]>;
```

## makeEncoded

Builds a `MessageStorage` service from an encoded storage driver.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:654`.

Vivid `MessageStorage.makeEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeEncoded: (encoded: Encoded) => Effect.Effect<MessageStorage["Service"], never, Snowflake.Generator>;
```

## noop

No-op `MessageStorage` service that does not persist messages or replies.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:880`.

Vivid `MessageStorage.noop` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const noop: MessageStorage["Service"];
```

## MemoryEntry

In-memory storage entry for a request envelope.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:910`.

Vivid `MessageStorage.MemoryEntry` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type MemoryEntry = {
    readonly envelope: Envelope.Encoded;
    lastReceivedChunk: Reply.ChunkEncoded | undefined;
    replies: Array<Reply.Encoded>;
    deliverAt: number | null;
};
```

## MemoryTransaction

Provides a context reference used in tests to simulate a transaction.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:924`.

Vivid `MessageStorage.MemoryTransaction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const MemoryTransaction: Context.Reference<boolean>;
```

## MemoryDriver

Service that provides an in-memory message storage driver with inspectable backing state.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:944`.

Vivid `MessageStorage.MemoryDriver` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class MemoryDriver extends MemoryDriver_base {
    static readonly layer: Layer.Layer<MemoryDriver>;
}
```

## layerNoop

Layer that provides the no-op `MessageStorage` service.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:1221`.

Vivid `MessageStorage.layerNoop` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerNoop: Layer.Layer<MessageStorage>;
```

## layerMemory

Layer that provides in-memory message storage and its backing `MemoryDriver`.

Source: `effect@4.0.2/src/cluster/MessageStorage.ts:1230`.

Vivid `MessageStorage.layerMemory` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerMemory: Layer.Layer<MessageStorage | MemoryDriver, never, ShardingConfig>;
```
