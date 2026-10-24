# Envelope

Import `effect/cluster/Envelope`. Source `effect@4.0.2/src/cluster/Envelope.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 19. Module-name matches in Vivid: 13. apps/desktop/src/main/scrub.ts:4, apps/desktop/src/main/scrub.ts:368, apps/desktop/src/main/scrub.ts:384

## TypeId

Type identifier used to mark runtime cluster envelope values.

Source: `effect@4.0.2/src/cluster/Envelope.ts:30`.

Vivid `Envelope.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const TypeId = "~effect/cluster/Envelope";
```

## OpaqueHole

Schema for a value that has already been encoded by the transport's hole codec.

Source: `effect@4.0.2/src/cluster/Envelope.ts:49`.

Vivid `Envelope.OpaqueHole` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const OpaqueHole: Schema.declare<any>;
```

## Envelope

Schema for runtime cluster envelopes recognized by their type identifier.

Source: `effect@4.0.2/src/cluster/Envelope.ts:428`.

Vivid `Envelope.Envelope` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export type Envelope<R extends Rpc.Any> = Request<R> | AckChunk | Interrupt;
export declare namespace Envelope {
    type Any = Envelope<any>;
}
export declare const Envelope: Schema.declare<Envelope<any>, Envelope<any>>;
```

## Encoded

JSON-serializable form of a cluster envelope.

Source: `effect@4.0.2/src/cluster/Envelope.ts:83`.

Vivid `Envelope.Encoded` matches: 0. No qualified match. Bare-name matches: 13. Aliased usage is unverified.

```ts
export type Encoded = PartialRequestEncoded | AckChunkEncoded | InterruptEncoded;
```

## Request

Schema for runtime request envelopes.

Source: `effect@4.0.2/src/cluster/Envelope.ts:439`.

Vivid `Envelope.Request` matches: 0. No qualified match. Bare-name matches: 101. Aliased usage is unverified.

```ts
export interface Request<in out Rpc extends Rpc.Any> {
    readonly [TypeId]: typeof TypeId;
    readonly _tag: "Request";
    readonly requestId: Snowflake;
    readonly address: EntityAddress;
    readonly tag: Rpc.Tag<Rpc>;
    readonly payload: Rpc.Payload<Rpc>;
    readonly headers: Headers.Headers;
    readonly traceId?: string;
    readonly spanId?: string;
    readonly sampled?: boolean;
}
export declare namespace Request {
    type Any = Request<any>;
}
export declare const Request: Schema.declare<Request.Any, Request.Any>;
```

## PartialRequest

Schema for a request envelope before its RPC payload has been decoded.

Source: `effect@4.0.2/src/cluster/Envelope.ts:139`.

Vivid `Envelope.PartialRequest` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class PartialRequest extends PartialRequest_base {
}
```

## PartialRequestEncoded

Serialized JSON shape of a request envelope.

Source: `effect@4.0.2/src/cluster/Envelope.ts:163`.

Vivid `Envelope.PartialRequestEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface PartialRequestEncoded {
    readonly _tag: "Request";
    readonly requestId: string;
    readonly address: {
        readonly shardId: {
            readonly group: string;
            readonly id: number;
        };
        readonly entityType: string;
        readonly entityId: string;
    };
    readonly tag: string;
    readonly payload: unknown;
    readonly headers: ReadonlyRecord<string, string>;
    readonly traceId?: string;
    readonly spanId?: string;
    readonly sampled?: boolean;
}
```

## AckChunk

Represents an envelope acknowledging receipt of a streamed reply chunk for a request.

Source: `effect@4.0.2/src/cluster/Envelope.ts:194`.

Vivid `Envelope.AckChunk` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class AckChunk extends AckChunk_base {
    readonly [TypeId] = "~effect/cluster/Envelope";
    withRequestId(requestId: Snowflake): AckChunk;
}
```

## AckChunkEncoded

Serialized JSON shape of an `AckChunk` envelope.

Source: `effect@4.0.2/src/cluster/Envelope.ts:230`.

Vivid `Envelope.AckChunkEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AckChunkEncoded {
    readonly _tag: "AckChunk";
    readonly id: string;
    readonly address: {
        readonly shardId: {
            readonly group: string;
            readonly id: number;
        };
        readonly entityType: string;
        readonly entityId: string;
    };
    readonly requestId: string;
    readonly replyId: string;
}
```

## Interrupt

Represents an envelope used to interrupt an in-flight entity request.

Source: `effect@4.0.2/src/cluster/Envelope.ts:252`.

Vivid `Envelope.Interrupt` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare class Interrupt extends Interrupt_base {
    readonly [TypeId] = "~effect/cluster/Envelope";
    withRequestId(requestId: Snowflake): Interrupt;
}
```

## InterruptEncoded

Serialized JSON shape of an `Interrupt` envelope.

Source: `effect@4.0.2/src/cluster/Envelope.ts:287`.

Vivid `Envelope.InterruptEncoded` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface InterruptEncoded {
    readonly _tag: "Interrupt";
    readonly id: string;
    readonly address: {
        readonly shardId: {
            readonly group: string;
            readonly id: number;
        };
        readonly entityType: string;
        readonly entityId: string;
    };
    readonly requestId: string;
}
```

## Partial

Decoded value type produced by the `Partial` envelope schema.

Source: `effect@4.0.2/src/cluster/Envelope.ts:327`.

Vivid `Envelope.Partial` matches: 0. No qualified match. Bare-name matches: 10. Aliased usage is unverified.

```ts
export declare const Partial: Schema.Union<readonly [
    typeof PartialRequest,
    typeof AckChunk,
    typeof Interrupt
]>;
export type Partial = typeof Partial.Type;
```

## PartialJson

JSON codec for partial cluster envelopes.

Source: `effect@4.0.2/src/cluster/Envelope.ts:336`.

Vivid `Envelope.PartialJson` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const PartialJson: Schema.Codec<AckChunk | Interrupt | PartialRequest, Encoded>;
```

## PartialArray

Schema for mutable arrays of JSON-encoded partial cluster envelopes.

Source: `effect@4.0.2/src/cluster/Envelope.ts:348`.

Vivid `Envelope.PartialArray` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const PartialArray: Schema.mutable<Schema.$Array<Schema.Codec<AckChunk | Interrupt | PartialRequest, Encoded>>>;
```

## isEnvelope

Returns `true` when the supplied value is a runtime cluster envelope.

Source: `effect@4.0.2/src/cluster/Envelope.ts:380`.

Vivid `Envelope.isEnvelope` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isEnvelope: (u: unknown) => u is Envelope<any>;
```

## makeRequest

Constructs a runtime request envelope and attaches the envelope type identifier.

Source: `effect@4.0.2/src/cluster/Envelope.ts:393`.

Vivid `Envelope.makeRequest` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeRequest: <Rpc extends Rpc.Any>(options: {
    readonly requestId: Snowflake;
    readonly address: EntityAddress;
    readonly tag: Rpc.Tag<Rpc>;
    readonly payload: Rpc.Payload<Rpc>;
    readonly headers: Headers.Headers;
    readonly traceId?: string | undefined;
    readonly spanId?: string | undefined;
    readonly sampled?: boolean | undefined;
}) => Request<Rpc>;
```

## RequestTransform

Transforms plain request data with `makeRequest` and encodes request envelopes back to their raw representation.

Source: `effect@4.0.2/src/cluster/Envelope.ts:452`.

Vivid `Envelope.RequestTransform` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const RequestTransform: SchemaTransformation.Transformation<Request.Any, any>;
```

## primaryKey

Returns the storage primary key for a request envelope whose payload has a primary key, or `null` when the envelope is not a keyed request.

Source: `effect@4.0.2/src/cluster/Envelope.ts:468`.

Vivid `Envelope.primaryKey` matches: 0. No qualified match. Bare-name matches: 39. Aliased usage is unverified.

```ts
export declare const primaryKey: <R extends Rpc.Any>(envelope: Envelope<R>) => string | null;
```

## primaryKeyByAddress

Builds a storage primary-key string from an entity address, RPC tag, and payload primary-key ID.

Source: `effect@4.0.2/src/cluster/Envelope.ts:487`.

Vivid `Envelope.primaryKeyByAddress` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const primaryKeyByAddress: (options: {
    readonly address: EntityAddress;
    readonly tag: string;
    readonly id: string;
}) => string;
```
