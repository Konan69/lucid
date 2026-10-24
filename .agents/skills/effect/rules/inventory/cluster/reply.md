# Reply

Import `effect/cluster/Reply`. Source `effect@4.0.2/src/cluster/Reply.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 11. Module-name matches in Vivid: 40. apps/desktop/src/main/computer.ts:335, apps/desktop/src/main/wire.ts:317, apps/desktop/src/main/wire.ts:355

## isReply

Returns `true` when the supplied value is a runtime cluster reply, based on the reply type identifier.

Source: `effect@4.0.2/src/cluster/Reply.ts:44`.

Vivid `Reply.isReply` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isReply: (u: unknown) => u is Reply<Rpc.Any>;
```

## Reply

Builds the transport codec for replies to the specified RPC, covering terminal `WithExit` replies and streaming `Chunk` replies.

Source: `effect@4.0.2/src/cluster/Reply.ts:429`.

Vivid `Reply.Reply` matches: 0. No qualified match. Bare-name matches: 40. Aliased usage is unverified.

```ts
export type Reply<R extends Rpc.Any> = WithExit<R> | Chunk<R>;
export declare const Reply: <R extends Rpc.Any>(rpc: R, codecFor: RpcSerialization.CodecFor) => Schema.Codec<WithExit<R> | Chunk<R>, Encoded, Rpc.ServicesClient<R>, Rpc.ServicesServer<R>>;
```

## Encoded

Schema for reply values that are already in encoded form.

Source: `effect@4.0.2/src/cluster/Reply.ts:76`.

Vivid `Reply.Encoded` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export type Encoded = WithExitEncoded | ChunkEncoded;
export declare const Encoded: Schema.Codec<Encoded>;
```

## ReplyWithContext

Represents a cluster reply paired with the RPC definition and service context required to serialize it for transport.

Source: `effect@4.0.2/src/cluster/Reply.ts:91`.

Vivid `Reply.ReplyWithContext` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class ReplyWithContext<R extends Rpc.Any> extends ReplyWithContext_base<{
    readonly reply: Reply<R>;
    readonly context: Context.Context<Rpc.Services<R>>;
    readonly rpc: R;
}> {
    static fromDefect(options: {
        readonly id: Snowflake;
        readonly requestId: Snowflake;
        readonly defect: unknown;
    }): ReplyWithContext<any>;
    static interrupt(options: {
        readonly id: Snowflake;
        readonly requestId: Snowflake;
    }): ReplyWithContext<any>;
}
```

## WithExitEncoded

Wire-format representation of a terminal reply containing the request id, reply id, and encoded RPC exit value.

Source: `effect@4.0.2/src/cluster/Reply.ts:153`.

Vivid `Reply.WithExitEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface WithExitEncoded<A = unknown, E = unknown> {
    readonly _tag: "WithExit";
    readonly requestId: string;
    readonly id: string;
    readonly exit: RpcMessage.ExitEncoded<A, E>;
}
```

## ChunkEncoded

Wire-format representation of a streaming reply chunk, including the request id, reply id, sequence number, and non-empty encoded values.

Source: `effect@4.0.2/src/cluster/Reply.ts:168`.

Vivid `Reply.ChunkEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface ChunkEncoded {
    readonly _tag: "Chunk";
    readonly requestId: string;
    readonly id: string;
    readonly sequence: number;
    readonly values: NonEmptyReadonlyArray<unknown>;
}
```

## Chunk

Represents a streaming RPC reply chunk for a request, carrying a non-empty batch of success values together with the reply id and sequence number.

Source: `effect@4.0.2/src/cluster/Reply.ts:188`.

Vivid `Reply.Chunk` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class Chunk<R extends Rpc.Any> extends Chunk_base<{
    readonly requestId: Snowflake;
    readonly id: Snowflake;
    readonly sequence: number;
    readonly values: NonEmptyReadonlyArray<Rpc.SuccessChunk<R>>;
}> {
    readonly [TypeId] = "~effect/cluster/Reply";
    static emptyFrom(requestId: Snowflake): Chunk<Rpc.Any>;
    static readonly Any: Schema.declare<Chunk<never>, Chunk<never>>;
    static readonly transform: SchemaTransformation.Transformation<any, any>;
    static schema<R extends Rpc.Any>(rpc: R): Schema.declareConstructor<Chunk<R>, Chunk<R>, readonly [
        Rpc.SuccessExitSchema<R>
    ]>;
    static schemaFrom<Success extends Schema.Constraint>(success: Success): Schema.declareConstructor<Chunk<Rpc.Any>, Chunk<Rpc.Any>, readonly [
        Success
    ]>;
    withRequestId(requestId: Snowflake): Chunk<R>;
}
```

## WithExit

Represents a terminal RPC reply for a request, carrying the final `Exit` for the remote call.

Source: `effect@4.0.2/src/cluster/Reply.ts:320`.

Vivid `Reply.WithExit` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class WithExit<R extends Rpc.Any> extends WithExit_base<{
    readonly requestId: Snowflake;
    readonly id: Snowflake;
    readonly exit: Rpc.Exit<R>;
}> {
    readonly [TypeId] = "~effect/cluster/Reply";
    static is(u: unknown): u is WithExit<any>;
    static schema<R extends Rpc.Any>(rpc: R): Schema.declareConstructor<WithExit<R>, WithExit<R>, readonly [
        Schema.Exit<Rpc.SuccessExitSchema<R>, Rpc.ErrorExitSchema<R>, Rpc.DefectSchema>
    ]>;
    static schemaFrom<Success extends Schema.Constraint, Error extends Schema.Constraint, Defect extends Schema.Constraint>(exitSchema: Schema.Exit<Success, Error, Defect>): Schema.declareConstructor<WithExit<Rpc.Any>, WithExit<Rpc.Any>, readonly [
        Schema.Exit<Success, Error, Defect>
    ]>;
    withRequestId(requestId: Snowflake): WithExit<R>;
}
```

## serialize

Serializes a `ReplyWithContext` into its encoded wire representation, using the reply's RPC schema and context and refailing encoding errors as `MalformedMessage`.

Source: `effect@4.0.2/src/cluster/Reply.ts:461`.

Vivid `Reply.serialize` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const serialize: <R extends Rpc.Any>(self: ReplyWithContext<R>, codecFor: RpcSerialization.CodecFor) => Effect.Effect<Encoded, MalformedMessage>;
```

## serializeOrDefect

Serializes a `ReplyWithContext`, falling back to a serializable defect reply when the original reply cannot be encoded.

Source: `effect@4.0.2/src/cluster/Reply.ts:482`.

Vivid `Reply.serializeOrDefect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const serializeOrDefect: <R extends Rpc.Any>(self: ReplyWithContext<R>, codecFor: RpcSerialization.CodecFor) => Effect.Effect<Encoded>;
```

## serializeLastReceived

Serializes an outgoing request's last received reply when one exists, returning `None` when no reply has been received and refailing encoding errors as `MalformedMessage`.

Source: `effect@4.0.2/src/cluster/Reply.ts:509`.

Vivid `Reply.serializeLastReceived` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const serializeLastReceived: <R extends Rpc.Any>(self: OutgoingRequest<R>, codecFor: RpcSerialization.CodecFor) => Effect.Effect<Option.Option<Encoded>, MalformedMessage>;
```
