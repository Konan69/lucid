# ClusterSchema

Import `effect/cluster/ClusterSchema`. Source `effect@4.0.2/src/cluster/ClusterSchema.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 9. Module-name matches in Vivid: 0. No bare-name match.

## Abandon

Annotation carried by an interruption when a persisted cluster request is abandoned by its current runner and must continue under another owner.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:25`.

Vivid `ClusterSchema.Abandon` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class Abandon extends Abandon_base {
    static annotation: Context.Context<Abandon | Cause.StackTrace>;
}
```

## Persisted

Annotation that marks whether a cluster request should be persisted in mailbox storage.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:47`.

Vivid `ClusterSchema.Persisted` matches: 0. No qualified match. Bare-name matches: 6. Aliased usage is unverified.

```ts
export declare const Persisted: Context.Reference<boolean>;
```

## WithTransaction

Annotation that marks whether request handling should be wrapped in the configured message storage transaction.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:74`.

Vivid `ClusterSchema.WithTransaction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const WithTransaction: Context.Reference<boolean>;
```

## Uninterruptible

Annotation that controls whether a cluster request is treated as uninterruptible.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:93`.

Vivid `ClusterSchema.Uninterruptible` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const Uninterruptible: Context.Reference<"client" | "server" | boolean>;
```

## isUninterruptibleForServer

Returns whether the `Uninterruptible` annotation applies to server-side request handling for the provided context.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:113`.

Vivid `ClusterSchema.isUninterruptibleForServer` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isUninterruptibleForServer: (context: Context.Context<never>) => boolean;
```

## isUninterruptibleForClient

Returns whether the `Uninterruptible` annotation applies to client-side request handling for the provided context.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:139`.

Vivid `ClusterSchema.isUninterruptibleForClient` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isUninterruptibleForClient: (context: Context.Context<never>) => boolean;
```

## ShardGroup

Annotation that selects the shard group for an entity id.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:155`.

Vivid `ClusterSchema.ShardGroup` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const ShardGroup: Context.Reference<(entityId: EntityId) => string>;
```

## ClientTracingEnabled

Annotation that controls whether client-side cluster request tracing is enabled.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:172`.

Vivid `ClusterSchema.ClientTracingEnabled` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const ClientTracingEnabled: Context.Reference<boolean>;
```

## Dynamic

Context reference for deriving request annotations from a cluster request.

Source: `effect@4.0.2/src/cluster/ClusterSchema.ts:193`.

Vivid `ClusterSchema.Dynamic` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const Dynamic: Context.Reference<(annotations: Context.Context<never>, request: Request<Rpc.AnyWithProps>) => Context.Context<never>>;
```
