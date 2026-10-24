# HttpRunner

Import `effect/cluster/HttpRunner`. Source `effect@4.0.2/src/cluster/HttpRunner.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 13. Module-name matches in Vivid: 0. No bare-name match.

## layerClientProtocolHttp

Provides a runner RPC client protocol that connects to runner addresses over HTTP.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:49`.

Vivid `HttpRunner.layerClientProtocolHttp` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerClientProtocolHttp: (options: {
    readonly path: string;
    readonly https?: boolean | undefined;
}) => Layer.Layer<RpcClientProtocol, never, RpcSerialization.RpcSerialization | HttpClient.HttpClient>;
```

## layerClientProtocolHttpDefault

Default HTTP runner client protocol layer using path `/`.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:87`.

Vivid `HttpRunner.layerClientProtocolHttpDefault` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerClientProtocolHttpDefault: Layer.Layer<Runners.RpcClientProtocol, never, RpcSerialization.RpcSerialization | HttpClient.HttpClient>;
```

## layerClientProtocolWebsocket

Provides a runner RPC client protocol that connects to runner addresses over WebSocket.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:106`.

Vivid `HttpRunner.layerClientProtocolWebsocket` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerClientProtocolWebsocket: (options: {
    readonly path: string;
    readonly https?: boolean | undefined;
}) => Layer.Layer<RpcClientProtocol, never, RpcSerialization.RpcSerialization | Socket.WebSocketConstructor>;
```

## layerClientProtocolWebsocketDefault

Default WebSocket runner client protocol layer using path `/`.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:144`.

Vivid `HttpRunner.layerClientProtocolWebsocketDefault` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerClientProtocolWebsocketDefault: Layer.Layer<Runners.RpcClientProtocol, never, RpcSerialization.RpcSerialization | Socket.WebSocketConstructor>;
```

## toHttpEffect

Builds an HTTP effect that serves runner RPCs over the HTTP protocol.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:162`.

Vivid `HttpRunner.toHttpEffect` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export declare const toHttpEffect: Effect.Effect<Effect.Effect<HttpServerResponse, never, Scope | HttpServerRequest>, never, Scope | RpcSerialization.RpcSerialization | Sharding.Sharding | MessageStorage>;
```

## toHttpEffectWebsocket

Builds an HTTP effect that serves runner RPCs over WebSocket.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:195`.

Vivid `HttpRunner.toHttpEffectWebsocket` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toHttpEffectWebsocket: Effect.Effect<Effect.Effect<HttpServerResponse, never, Scope | HttpServerRequest>, never, Scope | RpcSerialization.RpcSerialization | Sharding.Sharding | MessageStorage>;
```

## layerClient

Layer that provides `Sharding` and `Runners` using the configured runner RPC client protocol and storage services.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:224`.

Vivid `HttpRunner.layerClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerClient: Layer.Layer<Sharding.Sharding | Runners.Runners, never, ShardingConfig.ShardingConfig | Runners.RpcClientProtocol | MessageStorage | RunnerStorage | RunnerHealth>;
```

## layerHttpOptions

Layer that adds HTTP runner routes to the provided `HttpRouter`.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:239`.

Vivid `HttpRunner.layerHttpOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerHttpOptions: (options: {
    readonly path: HttpRouter.PathInput;
}) => Layer.Layer<Sharding.Sharding | Runners.Runners, never, RunnerStorage | RunnerHealth | RpcSerialization.RpcSerialization | MessageStorage | ShardingConfig.ShardingConfig | Runners.RpcClientProtocol | HttpRouter.HttpRouter>;
```

## layerWebsocketOptions

Layer that adds WebSocket runner routes to the provided `HttpRouter`.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:263`.

Vivid `HttpRunner.layerWebsocketOptions` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerWebsocketOptions: (options: {
    readonly path: HttpRouter.PathInput;
}) => Layer.Layer<Sharding.Sharding | Runners.Runners, never, ShardingConfig.ShardingConfig | Runners.RpcClientProtocol | MessageStorage | RunnerStorage | RunnerHealth | RpcSerialization.RpcSerialization | HttpRouter.HttpRouter>;
```

## layerHttp

Layer that serves runner routes at `/` and configures HTTP runner clients.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:292`.

Vivid `HttpRunner.layerHttp` matches: 0. No qualified match. Bare-name matches: 3. Aliased usage is unverified.

```ts
export declare const layerHttp: Layer.Layer<Sharding.Sharding | Runners.Runners, never, RpcSerialization.RpcSerialization | ShardingConfig.ShardingConfig | HttpClient.HttpClient | HttpServer.HttpServer | MessageStorage | RunnerStorage | RunnerHealth>;
```

## layerHttpClientOnly

Provides a client-only HTTP runner layer.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:323`.

Vivid `HttpRunner.layerHttpClientOnly` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerHttpClientOnly: Layer.Layer<Sharding.Sharding | Runners.Runners, never, RpcSerialization.RpcSerialization | ShardingConfig.ShardingConfig | HttpClient.HttpClient | MessageStorage | RunnerStorage>;
```

## layerWebsocket

Layer that serves runner routes at `/` and configures WebSocket runner clients.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:347`.

Vivid `HttpRunner.layerWebsocket` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerWebsocket: Layer.Layer<Sharding.Sharding | Runners.Runners, never, RpcSerialization.RpcSerialization | ShardingConfig.ShardingConfig | Socket.WebSocketConstructor | HttpServer.HttpServer | MessageStorage | RunnerStorage | RunnerHealth>;
```

## layerWebsocketClientOnly

Provides a client-only WebSocket runner layer.

Source: `effect@4.0.2/src/cluster/HttpRunner.ts:378`.

Vivid `HttpRunner.layerWebsocketClientOnly` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerWebsocketClientOnly: Layer.Layer<Sharding.Sharding | Runners.Runners, never, ShardingConfig.ShardingConfig | MessageStorage | RunnerStorage | RpcSerialization.RpcSerialization | Socket.WebSocketConstructor>;
```
