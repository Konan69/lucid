# EntityProxyServer

Import `effect/cluster/EntityProxyServer`. Source `effect@4.0.2/src/cluster/EntityProxyServer.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 3. Module-name matches in Vivid: 0. No bare-name match.

## layerHttpApi

Creates HTTP API handlers for an entity proxy group.

Source: `effect@4.0.2/src/cluster/EntityProxyServer.ts:37`.

Vivid `EntityProxyServer.layerHttpApi` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerHttpApi: <ApiId extends string, Groups extends HttpApiGroup.Constraint, Identifier extends HttpApiGroup.Identifier<Groups>, Type extends string, Rpcs extends Rpc.Any>(api: HttpApi.HttpApi<ApiId, Groups>, identifier: Identifier, entity: Entity.Entity<Type, Rpcs>) => Layer.Layer<HttpApiGroup.Service<ApiId, Identifier>, never, Sharding | Rpc.ServicesServer<Rpcs> | Rpc.ServicesClient<Rpcs>>;
```

## layerRpcHandlers

Creates RPC handlers for the group produced by `EntityProxy.toRpcGroup`.

Source: `effect@4.0.2/src/cluster/EntityProxyServer.ts:107`.

Vivid `EntityProxyServer.layerRpcHandlers` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerRpcHandlers: <const Type extends string, Rpcs extends Rpc.Any>(entity: Entity.Entity<Type, Rpcs>) => Layer.Layer<RpcHandlers<Rpcs, Type>, never, Sharding | Rpc.ServicesServer<Rpcs> | Rpc.ServicesClient<Rpcs>>;
```

## RpcHandlers

Union of RPC handler services required to serve the proxy RPCs for an entity.

Source: `effect@4.0.2/src/cluster/EntityProxyServer.ts:147`.

Vivid `EntityProxyServer.RpcHandlers` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type RpcHandlers<Rpcs extends Rpc.Any, Prefix extends string> = Rpcs extends Rpc.Rpc<infer _Tag, infer _Payload, infer _Success, infer _Error, infer _Middleware, infer _Requires> ? Rpc.Handler<`${Prefix}.${_Tag}`> | Rpc.Handler<`${Prefix}.${_Tag}Discard`> : never;
```
