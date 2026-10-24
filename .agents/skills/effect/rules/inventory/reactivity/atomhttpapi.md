# AtomHttpApi

Import `effect/reactivity/AtomHttpApi`. Source `effect@4.0.2/src/reactivity/AtomHttpApi.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## AtomHttpApiClient

A `Context.Service` for an HTTP API client integrated with atom reactivity.

Source: `effect@4.0.2/src/reactivity/AtomHttpApi.ts:45`.

Vivid `AtomHttpApi.AtomHttpApiClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AtomHttpApiClient<Self, Id extends string, Groups extends HttpApiGroup.Constraint> extends Context.Service<Self, HttpApiClient.Client<Groups, never, never>> {
    new (_: never): Context.ServiceClass.Shape<Id, HttpApiClient.Client<Groups, never, never>>;
    readonly runtime: Atom.AtomRuntime<Self>;
    readonly mutation: <GroupIdentifier extends HttpApiGroup.Identifier<Groups>, EndpointIdentifier extends HttpApiEndpoint.Identifier<HttpApiGroup.Endpoints<Group>>, Group extends HttpApiGroup.Constraint = HttpApiGroup.WithIdentifier<Groups, GroupIdentifier>, Endpoint extends HttpApiEndpoint.Constraint = HttpApiEndpoint.WithIdentifier<HttpApiGroup.Endpoints<Group>, EndpointIdentifier>, const ResponseMode extends HttpApiEndpoint.ClientResponseMode = "decoded-only">(group: GroupIdentifier, endpoint: EndpointIdentifier, options?: {
        readonly responseMode?: ResponseMode | undefined;
    }) => [
        Endpoint
    ] extends [
        HttpApiEndpoint.HttpApiEndpoint<infer _Identifier, infer _Method, infer _Path, infer _Params, infer _Query, infer _Payload, infer _Headers, infer _Success, infer _Error, infer _Middleware, infer _RE>
    ] ? Atom.AtomResultFn<Simplify<HttpApiEndpoint.ClientRequest<_Params, _Query, _Payload, _Headers, "decoded-only"> & {
        readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
    }>, ResponseByMode<Endpoint, ResponseMode>, ErrorByMode<_Error, _Middleware, ResponseMode>> : never;
    readonly query: <GroupIdentifier extends HttpApiGroup.Identifier<Groups>, EndpointIdentifier extends HttpApiEndpoint.Identifier<HttpApiGroup.Endpoints<Group>>, Group extends HttpApiGroup.Constraint = HttpApiGroup.WithIdentifier<Groups, GroupIdentifier>, Endpoint extends HttpApiEndpoint.Constraint = HttpApiEndpoint.WithIdentifier<HttpApiGroup.Endpoints<Group>, EndpointIdentifier>, const ResponseMode extends HttpApiEndpoint.ClientResponseMode = "decoded-only">(group: GroupIdentifier, endpoint: EndpointIdentifier, request: [
        Endpoint
    ] extends [
        HttpApiEndpoint.HttpApiEndpoint<infer _Identifier, infer _Method, infer _Path, infer _Params, infer _Query, infer _Payload, infer _Headers, infer _Success, infer _Error, infer _R, infer _RE>
    ] ? Simplify<HttpApiEndpoint.ClientRequest<_Params, _Query, _Payload, _Headers, ResponseMode> & {
        readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined;
        readonly timeToLive?: Duration.Input | undefined;
        readonly serializationKey?: string | undefined;
    }> : never) => [
        Endpoint
    ] extends [
        HttpApiEndpoint.HttpApiEndpoint<infer _Identifier, infer _Method, infer _Path, infer _Params, infer _Query, infer _Payload, infer _Headers, infer _Success, infer _Error, infer _Middleware, infer _RE>
    ] ? Atom.Atom<AsyncResult.AsyncResult<ResponseByMode<Endpoint, ResponseMode>, ErrorByMode<_Error, _Middleware, ResponseMode>>> : never;
}
```

## Service

Creates a `Context.Service` class for an HTTP API client backed by an atom runtime.

Source: `effect@4.0.2/src/reactivity/AtomHttpApi.ts:172`.

Vivid `AtomHttpApi.Service` matches: 0. No qualified match. Bare-name matches: 332. Aliased usage is unverified.

```ts
export declare const Service: <Self>() => <const Id extends string, ApiId extends string, Groups extends HttpApiGroup.Constraint>(id: Id, options: {
    readonly api: HttpApi.HttpApi<ApiId, Groups>;
    readonly httpClient: Layer.Layer<HttpApiGroup.ClientServices<Groups> | HttpClient.HttpClient> | ((get: Atom.AtomContext) => Layer.Layer<HttpApiGroup.ClientServices<Groups> | HttpClient.HttpClient>);
    readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
    readonly transformResponse?: ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>) | undefined;
    readonly baseUrl?: URL | string | undefined;
    readonly runtime?: Atom.RuntimeFactory | undefined;
}) => AtomHttpApiClient<Self, Id, Groups>;
```
