# ShardingRegistrationEvent

Import `effect/cluster/ShardingRegistrationEvent`. Source `effect@4.0.2/src/cluster/ShardingRegistrationEvent.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## ShardingRegistrationEvent

Represents events that can occur when a runner registers entities or singletons.

Source: `effect@4.0.2/src/cluster/ShardingRegistrationEvent.ts:22`.

Vivid `ShardingRegistrationEvent.ShardingRegistrationEvent` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type ShardingRegistrationEvent = EntityRegistered | SingletonRegistered;
```

## EntityRegistered

Constructors and matchers for sharding registration events.

Source: `effect@4.0.2/src/cluster/ShardingRegistrationEvent.ts:58`.

Vivid `ShardingRegistrationEvent.EntityRegistered` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface EntityRegistered {
    readonly _tag: "EntityRegistered";
    readonly entity: Entity<any, any>;
}
export declare const match: {
    <Cases extends {
        readonly [Tag in "EntityRegistered" | "SingletonRegistered"]: (args: Extract<ShardingRegistrationEvent, {
            readonly _tag: Tag;
        }>) => any;
    }>(cases: Cases): (value: ShardingRegistrationEvent) => import("../Unify.ts").Unify<ReturnType<Cases["EntityRegistered" | "SingletonRegistered"]>>;
    <Cases extends {
        readonly [Tag in "EntityRegistered" | "SingletonRegistered"]: (args: Extract<ShardingRegistrationEvent, {
            readonly _tag: Tag;
        }>) => any;
    }>(value: ShardingRegistrationEvent, cases: Cases): import("../Unify.ts").Unify<ReturnType<Cases["EntityRegistered" | "SingletonRegistered"]>>;
}, EntityRegistered: Data.TaggedEnum.ConstructorFrom<EntityRegistered, "_tag">, SingletonRegistered: Data.TaggedEnum.ConstructorFrom<SingletonRegistered, "_tag">;
```

## SingletonRegistered

Constructors and matchers for sharding registration events.

Source: `effect@4.0.2/src/cluster/ShardingRegistrationEvent.ts:58`.

Vivid `ShardingRegistrationEvent.SingletonRegistered` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SingletonRegistered {
    readonly _tag: "SingletonRegistered";
    readonly address: SingletonAddress;
}
export declare const match: {
    <Cases extends {
        readonly [Tag in "EntityRegistered" | "SingletonRegistered"]: (args: Extract<ShardingRegistrationEvent, {
            readonly _tag: Tag;
        }>) => any;
    }>(cases: Cases): (value: ShardingRegistrationEvent) => import("../Unify.ts").Unify<ReturnType<Cases["EntityRegistered" | "SingletonRegistered"]>>;
    <Cases extends {
        readonly [Tag in "EntityRegistered" | "SingletonRegistered"]: (args: Extract<ShardingRegistrationEvent, {
            readonly _tag: Tag;
        }>) => any;
    }>(value: ShardingRegistrationEvent, cases: Cases): import("../Unify.ts").Unify<ReturnType<Cases["EntityRegistered" | "SingletonRegistered"]>>;
}, EntityRegistered: Data.TaggedEnum.ConstructorFrom<EntityRegistered, "_tag">, SingletonRegistered: Data.TaggedEnum.ConstructorFrom<SingletonRegistered, "_tag">;
```

## match

Constructors and matchers for sharding registration events.

Source: `effect@4.0.2/src/cluster/ShardingRegistrationEvent.ts:58`.

Vivid `ShardingRegistrationEvent.match` matches: 0. No qualified match. Bare-name matches: 790. Aliased usage is unverified.

```ts
export declare const match: {
    <Cases extends {
        readonly [Tag in "EntityRegistered" | "SingletonRegistered"]: (args: Extract<ShardingRegistrationEvent, {
            readonly _tag: Tag;
        }>) => any;
    }>(cases: Cases): (value: ShardingRegistrationEvent) => import("../Unify.ts").Unify<ReturnType<Cases["EntityRegistered" | "SingletonRegistered"]>>;
    <Cases extends {
        readonly [Tag in "EntityRegistered" | "SingletonRegistered"]: (args: Extract<ShardingRegistrationEvent, {
            readonly _tag: Tag;
        }>) => any;
    }>(value: ShardingRegistrationEvent, cases: Cases): import("../Unify.ts").Unify<ReturnType<Cases["EntityRegistered" | "SingletonRegistered"]>>;
}, EntityRegistered: Data.TaggedEnum.ConstructorFrom<EntityRegistered, "_tag">, SingletonRegistered: Data.TaggedEnum.ConstructorFrom<SingletonRegistered, "_tag">;
```
