# AtomRpc

Import `effect/reactivity/AtomRpc`. Source `effect@4.0.2/src/reactivity/AtomRpc.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## AtomRpcClient

A `Context.Service` for a flattened RPC client integrated with atom reactivity.

Source: `effect@4.0.2/src/reactivity/AtomRpc.ts:45`.

Vivid `AtomRpc.AtomRpcClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AtomRpcClient<Self, Id extends string, Rpcs extends Rpc.Any> extends Context.Service<Self, RpcClient.RpcClient.Flat<Rpcs, RpcClientError>> {
    new (_: never): Context.ServiceClass.Shape<Id, RpcClient.RpcClient.Flat<Rpcs, RpcClientError>>;
    readonly runtime: Atom.AtomRuntime<Self>;
    readonly mutation: <Tag extends Rpc.Tag<Rpcs>>(arg: Tag) => Rpcs extends Rpc.Rpc<infer _Tag extends Tag, infer _Payload, infer _Success, infer _Error, infer _Middleware, infer _Requires> ? [
        _Success
    ] extends [
        RpcSchema.Stream<infer _A, infer _E>
    ] ? never : Atom.AtomResultFn<{
        readonly payload: Rpc.PayloadConstructor<Rpcs>;
        readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
        readonly headers?: Headers.Input | undefined;
    }, _Success["Type"], _Error["Type"] | RpcClientError | _Middleware["error"]["Type"] | _Middleware["~ClientError"]> : never;
    readonly query: <Tag extends Rpc.Tag<Rpcs>>(tag: Tag, payload: Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>, options?: {
        readonly headers?: Headers.Input | undefined;
        readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
        readonly timeToLive?: Duration.Input | undefined;
        readonly serializationKey?: string | undefined;
    }) => Rpcs extends Rpc.Rpc<infer _Tag extends Tag, infer _Payload, infer _Success, infer _Error, infer _Middleware, infer _Requires> ? [
        _Success
    ] extends [
        RpcSchema.Stream<infer _A, infer _E>
    ] ? Atom.Writable<Atom.PullResult<_A["Type"], _E["Type"] | _Error["Type"] | RpcClientError | _Middleware["error"]["Type"] | _Middleware["~ClientError"]>, void> : Atom.Atom<AsyncResult.AsyncResult<_Success["Type"], _Error["Type"] | RpcClientError | _Middleware["error"]["Type"] | _Middleware["~ClientError"]>> : never;
}
```

## Service

Creates a `Context.Service` class for an RPC client backed by an atom runtime.

Source: `effect@4.0.2/src/reactivity/AtomRpc.ts:135`.

Vivid `AtomRpc.Service` matches: 0. No qualified match. Bare-name matches: 332. Aliased usage is unverified.

```ts
export declare const Service: <Self>() => <const Id extends string, Rpcs extends Rpc.Any, ER, RM = RpcClient.Protocol | Rpc.MiddlewareClient<NoInfer<Rpcs>> | Rpc.ServicesClient<NoInfer<Rpcs>>>(id: Id, options: {
    readonly group: RpcGroup.RpcGroup<Rpcs>;
    readonly protocol: Layer.Layer<Exclude<NoInfer<RM>, Scope>, ER> | ((get: Atom.AtomContext) => Layer.Layer<Exclude<NoInfer<RM>, Scope>, ER>);
    readonly spanPrefix?: string | undefined;
    readonly spanAttributes?: Record<string, unknown> | undefined;
    readonly generateRequestId?: (() => RequestId) | undefined;
    readonly disableTracing?: boolean | undefined;
    readonly makeEffect?: Effect.Effect<RpcClient.RpcClient.Flat<Rpcs, RpcClientError>, never, RM> | undefined;
    readonly runtime?: Atom.RuntimeFactory | undefined;
}) => AtomRpcClient<Self, Id, Rpcs>;
```
