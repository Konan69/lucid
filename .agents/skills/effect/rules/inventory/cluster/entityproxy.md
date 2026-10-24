# EntityProxy

Import `effect/cluster/EntityProxy`. Source `effect@4.0.2/src/cluster/EntityProxy.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## toRpcGroup

Derives an `RpcGroup` from an `Entity`.

Source: `effect@4.0.2/src/cluster/EntityProxy.ts:66`.

Vivid `EntityProxy.toRpcGroup` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toRpcGroup: <Type extends string, Rpcs extends Rpc.Any>(entity: Entity.Entity<Type, Rpcs>) => RpcGroup.RpcGroup<ConvertRpcs<Rpcs, Type>>;
```

## ConvertRpcs

Type-level conversion used by `toRpcGroup`.

Source: `effect@4.0.2/src/cluster/EntityProxy.ts:103`.

Vivid `EntityProxy.ConvertRpcs` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type ConvertRpcs<Rpcs extends Rpc.Any, Prefix extends string> = Rpcs extends Rpc.Rpc<infer _Tag, infer _Payload, infer _Success, infer _Error, infer _Middleware, infer _Requires> ? Rpc.Rpc<`${Prefix}.${_Tag}`, Schema.Struct<{
    entityId: typeof Schema.String;
    payload: _Payload;
}>, _Success, Schema.Codec<_Error["Type"] | MailboxFull | AlreadyProcessingMessage | PersistenceError | EntityNotAssignedToRunner, _Error["Encoded"] | typeof MailboxFull["Encoded"] | typeof AlreadyProcessingMessage["Encoded"] | typeof PersistenceError["Encoded"] | typeof EntityNotAssignedToRunner["Encoded"], _Error["DecodingServices"], _Error["EncodingServices"]>> | Rpc.Rpc<`${Prefix}.${_Tag}Discard`, Schema.Struct<{
    entityId: typeof Schema.String;
    payload: _Payload;
}>, typeof Schema.Void, Schema.Union<[
    typeof MailboxFull,
    typeof AlreadyProcessingMessage,
    typeof PersistenceError
]>> : never;
```

## toHttpApiGroup

Derives an `HttpApiGroup` from an `Entity`.

Source: `effect@4.0.2/src/cluster/EntityProxy.ts:188`.

Vivid `EntityProxy.toHttpApiGroup` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toHttpApiGroup: <const Name extends string, Type extends string, Rpcs extends Rpc.Any>(name: Name, entity: Entity.Entity<Type, Rpcs>) => HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<Rpcs>>;
```

## ConvertHttpApi

Type-level conversion used by `toHttpApiGroup`.

Source: `effect@4.0.2/src/cluster/EntityProxy.ts:236`.

Vivid `EntityProxy.ConvertHttpApi` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type ConvertHttpApi<Rpcs extends Rpc.Any> = Rpcs extends Rpc.Rpc<infer _Tag, infer _Payload, infer _Success, infer _Error, infer _Middleware, infer _Requires> ? HttpApiEndpoint.HttpApiEndpoint<_Tag, "POST", `/${Lowercase<_Tag>}/:entityId`, Schema.Struct<{
    entityId: typeof EntityId;
}>, never, _Payload, never, _Success, _Error | typeof MailboxFull | typeof AlreadyProcessingMessage | typeof PersistenceError | typeof EntityNotAssignedToRunner> | HttpApiEndpoint.HttpApiEndpoint<`${_Tag}Discard`, "POST", `/${Lowercase<_Tag>}/:entityId/discard`, Schema.Struct<{
    entityId: typeof EntityId;
}>, never, _Payload, never, Schema.Void, typeof MailboxFull | typeof AlreadyProcessingMessage | typeof PersistenceError> : never;
```
