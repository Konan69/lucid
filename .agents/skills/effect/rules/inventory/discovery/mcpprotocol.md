# McpProtocol

Import `effect/ai/McpProtocol`. Source `effect@4.0.2/src/ai/McpProtocol.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## StatefulProtocolVersion

MCP protocol versions that use initialization and server-managed sessions.

Source: `effect@4.0.2/src/ai/McpProtocol.ts:36`.

Vivid `McpProtocol.StatefulProtocolVersion` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type StatefulProtocolVersion = Exclude<ProtocolVersion, "2026-07-28">;
```

## StatelessRuntimeProfile

Request information decoded by a stateless MCP runtime.

Source: `effect@4.0.2/src/ai/McpProtocol.ts:107`.

Vivid `McpProtocol.StatelessRuntimeProfile` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface StatelessRuntimeProfile {
    readonly protocolVersion: string;
    readonly clientCapabilities: Schema.JsonObject;
    readonly clientInfo?: McpSchema.Implementation | undefined;
    readonly requestMetadata: Schema.JsonObject;
}
```

## StatefulRuntimeDescriptor

Stateful lifecycle runtime declaration carried by a protocol adapter.

Source: `effect@4.0.2/src/ai/McpProtocol.ts:121`.

Vivid `McpProtocol.StatefulRuntimeDescriptor` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface StatefulRuntimeDescriptor {
    readonly _tag: "Stateful";
    readonly transport: TransportPolicy;
}
```

## StatelessRuntimeDescriptor

Stateless lifecycle runtime declaration carried by a protocol adapter.

Source: `effect@4.0.2/src/ai/McpProtocol.ts:133`.

Vivid `McpProtocol.StatelessRuntimeDescriptor` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface StatelessRuntimeDescriptor {
    readonly _tag: "Stateless";
    readonly transport: TransportPolicy;
    readonly profileFromRequestMetadata: (metadata: unknown) => Effect.Effect<StatelessRuntimeProfile, unknown>;
}
```
