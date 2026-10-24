# Message

Import `effect/cluster/Message`. Source `effect@4.0.2/src/cluster/Message.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 13. Module-name matches in Vivid: 175. apps/mobile/DESIGN-SOURCES.md:12, apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift:75, apps/mobile/src/data/delivery.ts:9

## Incoming

Message read by a runner from storage or transport.

Source: `effect@4.0.2/src/cluster/Message.ts:41`.

Vivid `Message.Incoming` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export type Incoming<R extends Rpc.Any> = IncomingRequest<R> | IncomingEnvelope;
```

## IncomingLocal

Locally decoded incoming message for in-process delivery.

Source: `effect@4.0.2/src/cluster/Message.ts:54`.

Vivid `Message.IncomingLocal` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type IncomingLocal<R extends Rpc.Any> = IncomingRequestLocal<R> | IncomingEnvelope;
```

## incomingLocalFromOutgoing

Converts an outgoing message into a locally deliverable incoming message.

Source: `effect@4.0.2/src/cluster/Message.ts:68`.

Vivid `Message.incomingLocalFromOutgoing` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const incomingLocalFromOutgoing: <R extends Rpc.Any>(self: Outgoing<R>) => IncomingLocal<R>;
```

## IncomingRequest

Represents an incoming persisted request whose payload has not yet been decoded with the RPC schema.

Source: `effect@4.0.2/src/cluster/Message.ts:96`.

Vivid `Message.IncomingRequest` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class IncomingRequest<R extends Rpc.Any> extends IncomingRequest_base<{
    readonly envelope: Envelope.PartialRequest;
    readonly lastSentReply: Option.Option<Reply.Encoded>;
    readonly respond: (reply: Reply.ReplyWithContext<R>) => Effect.Effect<void, MalformedMessage | PersistenceError>;
    readonly codecFor: RpcSerialization.CodecFor;
    readonly callerScope?: Scope.Scope | undefined;
}> {
}
```

## IncomingRequestLocal

Represents an incoming request for local delivery with a decoded payload.

Source: `effect@4.0.2/src/cluster/Message.ts:128`.

Vivid `Message.IncomingRequestLocal` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class IncomingRequestLocal<R extends Rpc.Any> extends IncomingRequestLocal_base<{
    readonly envelope: Envelope.Request<R>;
    readonly lastSentReply: Option.Option<Reply.Reply<R>>;
    readonly respond: (reply: Reply.Reply<R>) => Effect.Effect<void, MalformedMessage | PersistenceError>;
    readonly annotations: Context.Context<never>;
    readonly callerScope?: Scope.Scope | undefined;
}> {
}
```

## IncomingEnvelope

Represents an incoming control envelope carrying an `AckChunk` or `Interrupt`.

Source: `effect@4.0.2/src/cluster/Message.ts:149`.

Vivid `Message.IncomingEnvelope` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class IncomingEnvelope extends IncomingEnvelope_base<{
    readonly _tag: "IncomingEnvelope";
    readonly envelope: Envelope.AckChunk | Envelope.Interrupt;
}> {
}
```

## Outgoing

Message produced for storage or transport.

Source: `effect@4.0.2/src/cluster/Message.ts:165`.

Vivid `Message.Outgoing` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export type Outgoing<R extends Rpc.Any> = OutgoingRequest<R> | OutgoingEnvelope;
```

## OutgoingRequest

Represents an outgoing entity request with decoded payload and RPC metadata.

Source: `effect@4.0.2/src/cluster/Message.ts:179`.

Vivid `Message.OutgoingRequest` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class OutgoingRequest<R extends Rpc.Any> extends OutgoingRequest_base<{
    readonly envelope: Envelope.Request<R>;
    readonly context: Context.Context<Rpc.Services<R>>;
    readonly lastReceivedReply: Option.Option<Reply.Reply<R>>;
    readonly rpc: R;
    readonly respond: (reply: Reply.Reply<R>) => Effect.Effect<void>;
    readonly annotations: Context.Context<never>;
}> {
    encodedCache?: {
        readonly codecFor: RpcSerialization.CodecFor;
        readonly envelope: Envelope.PartialRequest;
    };
}
```

## OutgoingEnvelope

Represents an outgoing control envelope paired with RPC metadata.

Source: `effect@4.0.2/src/cluster/Message.ts:212`.

Vivid `Message.OutgoingEnvelope` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class OutgoingEnvelope extends OutgoingEnvelope_base<{
    readonly envelope: Envelope.AckChunk | Envelope.Interrupt;
    readonly rpc: Rpc.AnyWithProps;
}> {
    static interrupt(options: {
        readonly address: EntityAddress;
        readonly id: Snowflake;
        readonly requestId: Snowflake;
    }): OutgoingEnvelope;
}
```

## serialize

Serializes an outgoing message into a partial envelope.

Source: `effect@4.0.2/src/cluster/Message.ts:254`.

Vivid `Message.serialize` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const serialize: <Rpc extends Rpc.Any>(message: Outgoing<Rpc>, codecFor: RpcSerialization.CodecFor) => Effect.Effect<Envelope.Partial, MalformedMessage>;
```

## serializeEnvelope

Serializes an outgoing message into its JSON envelope representation.

Source: `effect@4.0.2/src/cluster/Message.ts:284`.

Vivid `Message.serializeEnvelope` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const serializeEnvelope: <Rpc extends Rpc.Any>(message: Outgoing<Rpc>) => Effect.Effect<Envelope.Encoded, MalformedMessage, never>;
```

## serializeRequest

Encodes the payload of an `OutgoingRequest` with the request's RPC payload schema and service context.

Source: `effect@4.0.2/src/cluster/Message.ts:304`.

Vivid `Message.serializeRequest` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const serializeRequest: <Rpc extends Rpc.Any>(self: OutgoingRequest<Rpc>, codecFor: RpcSerialization.CodecFor) => Effect.Effect<Envelope.PartialRequest, MalformedMessage>;
```

## deserializeLocal

Decodes a partial envelope back into a locally deliverable incoming message.

Source: `effect@4.0.2/src/cluster/Message.ts:332`.

Vivid `Message.deserializeLocal` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const deserializeLocal: <Rpc extends Rpc.Any>(self: Outgoing<Rpc>, encoded: Envelope.Partial, codecFor: RpcSerialization.CodecFor) => Effect.Effect<IncomingLocal<Rpc>, MalformedMessage>;
```
