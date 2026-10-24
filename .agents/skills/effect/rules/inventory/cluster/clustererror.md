# ClusterError

Import `effect/cluster/ClusterError`. Source `effect@4.0.2/src/cluster/ClusterError.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 7. Module-name matches in Vivid: 0. No bare-name match.

## EntityNotAssignedToRunner

Represents an error that occurs when a Runner receives a message for an entity that is not assigned to the receiving runner.

Source: `effect@4.0.2/src/cluster/ClusterError.ts:30`.

Vivid `ClusterError.EntityNotAssignedToRunner` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class EntityNotAssignedToRunner extends EntityNotAssignedToRunner_base {
    readonly [TypeId] = "~effect/cluster/ClusterError";
    static is(u: unknown): u is EntityNotAssignedToRunner;
}
```

## MalformedMessage

Represents an error that occurs when a message fails at a schema serialization or deserialization boundary.

Source: `effect@4.0.2/src/cluster/ClusterError.ts:68`.

Vivid `ClusterError.MalformedMessage` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class MalformedMessage extends MalformedMessage_base {
    readonly [TypeId] = "~effect/cluster/ClusterError";
    static is(u: unknown): u is MalformedMessage;
    static refail: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, MalformedMessage, R>;
}
```

## PersistenceError

Represents an error that occurs when a message fails to be persisted into cluster's mailbox storage.

Source: `effect@4.0.2/src/cluster/ClusterError.ts:111`.

Vivid `ClusterError.PersistenceError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class PersistenceError extends PersistenceError_base {
    readonly [TypeId] = "~effect/cluster/ClusterError";
    static refail<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersistenceError, R>;
}
```

## RunnerNotRegistered

Represents an error that occurs when a Runner is not registered with the shard manager.

Source: `effect@4.0.2/src/cluster/ClusterError.ts:142`.

Vivid `ClusterError.RunnerNotRegistered` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class RunnerNotRegistered extends RunnerNotRegistered_base {
    readonly [TypeId] = "~effect/cluster/ClusterError";
}
```

## RunnerUnavailable

Represents an error that occurs when a Runner is unresponsive.

Source: `effect@4.0.2/src/cluster/ClusterError.ts:162`.

Vivid `ClusterError.RunnerUnavailable` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class RunnerUnavailable extends RunnerUnavailable_base {
    readonly [TypeId] = "~effect/cluster/ClusterError";
    static is(u: unknown): u is RunnerUnavailable;
}
```

## MailboxFull

Represents an error that occurs when the entity mailbox is full.

Source: `effect@4.0.2/src/cluster/ClusterError.ts:203`.

Vivid `ClusterError.MailboxFull` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class MailboxFull extends MailboxFull_base {
    readonly [TypeId] = "~effect/cluster/ClusterError";
    static is(u: unknown): u is MailboxFull;
}
```

## AlreadyProcessingMessage

Represents an error that occurs when the same request envelope is already being processed.

Source: `effect@4.0.2/src/cluster/ClusterError.ts:238`.

Vivid `ClusterError.AlreadyProcessingMessage` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class AlreadyProcessingMessage extends AlreadyProcessingMessage_base {
    readonly [TypeId] = "~effect/cluster/ClusterError";
    static is(u: unknown): u is AlreadyProcessingMessage;
}
```
