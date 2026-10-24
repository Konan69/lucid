# RequestResolver

Import `effect/RequestResolver`. Source `effect@4.0.2/src/RequestResolver.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 20. Module-name matches in Vivid: 4. apps/server/src/connections/effects.ts:13, apps/server/src/connections/effects.ts:279, apps/server/src/connections/effects.ts:294

## RequestResolver

Namespace containing type-level helpers associated with `RequestResolver`.

Source: `effect@4.0.2/src/RequestResolver.ts:116`.

Vivid `RequestResolver.RequestResolver` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export interface RequestResolver<in A extends Request.Any> extends RequestResolver.Variance<A>, Pipeable {
    readonly delay: Effect.Effect<void>;
    batchKey(entry: Request.Entry<A>): unknown;
    readonly preCheck: ((entry: Request.Entry<A>) => boolean) | undefined;
    collectWhile(entries: ReadonlySet<Request.Entry<A>>): boolean;
    runAll(entries: NonEmptyArray<Request.Entry<A>>, key: unknown): Effect.Effect<void, Request.Error<A>>;
}
export declare namespace RequestResolver {
    interface Variance<in A> {
        readonly [TypeId]: {
            readonly _A: Types.Contravariant<A>;
        };
    }
}
```

## isRequestResolver

Returns `true` if the specified value is a `RequestResolver`, `false` otherwise.

Source: `effect@4.0.2/src/RequestResolver.ts:159`.

Vivid `RequestResolver.isRequestResolver` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isRequestResolver: (u: unknown) => u is RequestResolver<any>;
```

## makeWith

Creates a request resolver with fine-grained control over its behavior.

Source: `effect@4.0.2/src/RequestResolver.ts:190`.

Vivid `RequestResolver.makeWith` matches: 0. No qualified match. Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const makeWith: <A extends Request.Any>(options: {
    readonly batchKey: (request: Request.Entry<A>) => unknown;
    readonly preCheck?: ((entry: Request.Entry<A>) => boolean) | undefined;
    readonly delay: Effect.Effect<void>;
    readonly collectWhile: (requests: ReadonlySet<Request.Entry<A>>) => boolean;
    readonly runAll: (entries: NonEmptyArray<Request.Entry<A>>, key: unknown) => Effect.Effect<void, Request.Error<A>>;
}) => RequestResolver<A>;
```

## make

Constructs a request resolver with the specified method to run requests.

Source: `effect@4.0.2/src/RequestResolver.ts:243`.

Vivid `RequestResolver.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <A extends Request.Any>(runAll: (entries: NonEmptyArray<Request.Entry<A>>, key: unknown) => Effect.Effect<void, Request.Error<A>>) => RequestResolver<A>;
```

## makeGrouped

Constructs a request resolver with the requests grouped by a calculated key.

Source: `effect@4.0.2/src/RequestResolver.ts:302`.

Vivid `RequestResolver.makeGrouped` matches: 1. apps/server/src/connections/effects.ts:294 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const makeGrouped: <A extends Request.Any, K>(options: {
    readonly key: (entry: Request.Entry<A>) => K;
    readonly resolver: (entries: NonEmptyArray<Request.Entry<A>>, key: K) => Effect.Effect<void, Request.Error<A>>;
}) => RequestResolver<A>;
```

## fromFunction

Constructs a request resolver from a pure function.

Source: `effect@4.0.2/src/RequestResolver.ts:357`.

Vivid `RequestResolver.fromFunction` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromFunction: <A extends Request.Any>(f: (entry: Request.Entry<A>) => Request.Success<A>) => RequestResolver<A>;
```

## fromFunctionBatched

Constructs a request resolver from a pure function that takes a list of requests and returns a list of results of the same size. Each item in the result list must correspond to the item at the same index in the request list.

Source: `effect@4.0.2/src/RequestResolver.ts:403`.

Vivid `RequestResolver.fromFunctionBatched` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromFunctionBatched: <A extends Request.Any>(f: (entries: NonEmptyArray<Request.Entry<A>>) => Iterable<Request.Success<A>>) => RequestResolver<A>;
```

## fromEffect

Constructs a request resolver from an effectual function.

Source: `effect@4.0.2/src/RequestResolver.ts:450`.

Vivid `RequestResolver.fromEffect` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const fromEffect: <A extends Request.Any>(f: (entry: Request.Entry<A>) => Effect.Effect<Request.Success<A>, Request.Error<A>>) => RequestResolver<A>;
```

## fromEffectTagged

Constructs a request resolver from a list of tags paired to functions, that takes a list of requests and returns a list of results of the same size. Each item in the result list must correspond to the item at the same index in the request list.

Source: `effect@4.0.2/src/RequestResolver.ts:517`.

Vivid `RequestResolver.fromEffectTagged` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const fromEffectTagged: <A extends Request.Any & {
    readonly _tag: string;
}>() => <Fns extends {
    readonly [Tag in A["_tag"]]: [
        Extract<A, {
            readonly _tag: Tag;
        }>
    ] extends [
        infer Req
    ] ? Req extends Request.Request<infer ReqA, infer ReqE, infer _ReqR> ? (requests: Array<Request.Entry<Req>>) => Effect.Effect<Iterable<ReqA>, ReqE> : never : never;
}>(fns: Fns) => RequestResolver<A>;
```

## setDelayEffect

Sets the batch delay effect for this request resolver.

Source: `effect@4.0.2/src/RequestResolver.ts:602`.

Vivid `RequestResolver.setDelayEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setDelayEffect: {
    (delay: Effect.Effect<void>): <A extends Request.Any>(self: RequestResolver<A>) => RequestResolver<A>;
    <A extends Request.Any>(self: RequestResolver<A>, delay: Effect.Effect<void>): RequestResolver<A>;
};
```

## setDelay

Sets the batch delay window for this request resolver to the specified duration.

Source: `effect@4.0.2/src/RequestResolver.ts:724`.

Vivid `RequestResolver.setDelay` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const setDelay: {
    (duration: Duration.Input): <A extends Request.Any>(self: RequestResolver<A>) => RequestResolver<A>;
    <A extends Request.Any>(self: RequestResolver<A>, duration: Duration.Input): RequestResolver<A>;
};
```

## around

Wraps request resolver execution between `before` and `after` effects.

Source: `effect@4.0.2/src/RequestResolver.ts:848`.

Vivid `RequestResolver.around` matches: 0. No qualified match. Bare-name matches: 166. Aliased usage is unverified.

```ts
export declare const around: {
    <A extends Request.Any, A2, X>(before: (entries: NonEmptyArray<Request.Entry<NoInfer<A>>>) => Effect.Effect<A2, Request.Error<A>>, after: (entries: NonEmptyArray<Request.Entry<NoInfer<A>>>, a: A2) => Effect.Effect<X, Request.Error<A>>): (self: RequestResolver<A>) => RequestResolver<A>;
    <A extends Request.Any, A2, X>(self: RequestResolver<A>, before: (entries: NonEmptyArray<Request.Entry<NoInfer<A>>>) => Effect.Effect<A2, Request.Error<A>>, after: (entries: NonEmptyArray<Request.Entry<NoInfer<A>>>, a: A2) => Effect.Effect<X, Request.Error<A>>): RequestResolver<A>;
};
```

## never

Creates a request resolver that never executes requests.

Source: `effect@4.0.2/src/RequestResolver.ts:988`.

Vivid `RequestResolver.never` matches: 0. No qualified match. Bare-name matches: 1556. Aliased usage is unverified.

```ts
export declare const never: RequestResolver<never>;
```

## batchN

Returns a request resolver that collects at most `n` requests into each batch.

Source: `effect@4.0.2/src/RequestResolver.ts:1044`.

Vivid `RequestResolver.batchN` matches: 1. apps/server/src/connections/effects.ts:325 Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const batchN: {
    (n: number): <A extends Request.Any>(self: RequestResolver<A>) => RequestResolver<A>;
    <A extends Request.Any>(self: RequestResolver<A>, n: number): RequestResolver<A>;
};
```

## grouped

Transforms a request resolver by grouping requests using the specified key function.

Source: `effect@4.0.2/src/RequestResolver.ts:1224`.

Vivid `RequestResolver.grouped` matches: 0. No qualified match. Bare-name matches: 33. Aliased usage is unverified.

```ts
export declare const grouped: {
    <A extends Request.Any, K>(f: (entry: Request.Entry<A>) => K): (self: RequestResolver<A>) => RequestResolver<A>;
    <A extends Request.Any, K>(self: RequestResolver<A>, f: (entry: Request.Entry<A>) => K): RequestResolver<A>;
};
```

## race

Returns a request resolver that sends each batch to both resolvers and completes with the first resolver to finish.

Source: `effect@4.0.2/src/RequestResolver.ts:1408`.

Vivid `RequestResolver.race` matches: 0. No qualified match. Bare-name matches: 32. Aliased usage is unverified.

```ts
export declare const race: {
    <A2 extends Request.Any>(that: RequestResolver<A2>): <A extends Request.Any>(self: RequestResolver<A>) => RequestResolver<A2 & A>;
    <A extends Request.Any, A2 extends Request.Any>(self: RequestResolver<A>, that: RequestResolver<A2>): RequestResolver<A & A2>;
};
```

## withSpan

Adds a tracing span to the request resolver, which will also add any span links from the request's.

Source: `effect@4.0.2/src/RequestResolver.ts:1563`.

Vivid `RequestResolver.withSpan` matches: 0. No qualified match. Bare-name matches: 45. Aliased usage is unverified.

```ts
export declare const withSpan: {
    <A extends Request.Any>(name: string, options?: Tracer.SpanOptions | ((entries: NonEmptyArray<Request.Entry<A>>) => Tracer.SpanOptions) | undefined): (self: RequestResolver<A>) => RequestResolver<A>;
    <A extends Request.Any>(self: RequestResolver<A>, name: string, options?: Tracer.SpanOptions | ((entries: NonEmptyArray<Request.Entry<A>>) => Tracer.SpanOptions) | undefined): RequestResolver<A>;
};
```

## asCache

Wraps a request resolver in a cache, allowing it to cache results up to a specified capacity and optional time-to-live.

Source: `effect@4.0.2/src/RequestResolver.ts:1718`.

Vivid `RequestResolver.asCache` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const asCache: {
    <A extends Request.Any, ServiceMode extends "lookup" | "construction" = never>(options: {
        readonly capacity: number;
        readonly timeToLive?: ((exit: Request.Result<A>, request: A) => Duration.Input) | undefined;
        readonly requireServicesAt?: ServiceMode | undefined;
    }): (self: RequestResolver<A>) => Effect.Effect<Cache.Cache<A, Request.Success<A>, Request.Error<A>, "construction" extends ServiceMode ? never : Request.Services<A>>, never, "construction" extends ServiceMode ? Request.Services<A> : never>;
    <A extends Request.Any, ServiceMode extends "lookup" | "construction" = never>(self: RequestResolver<A>, options: {
        readonly capacity: number;
        readonly timeToLive?: ((exit: Request.Result<A>, request: A) => Duration.Input) | undefined;
        readonly requireServicesAt?: ServiceMode | undefined;
    }): Effect.Effect<Cache.Cache<A, Request.Success<A>, Request.Error<A>, "construction" extends ServiceMode ? never : Request.Services<A>>, never, "construction" extends ServiceMode ? Request.Services<A> : never>;
};
```

## withCache

Adds a bounded in-memory cache to a request resolver.

Source: `effect@4.0.2/src/RequestResolver.ts:1871`.

Vivid `RequestResolver.withCache` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const withCache: {
    <A extends Request.Any>(options: {
        readonly capacity: number;
        readonly strategy?: "lru" | "fifo" | undefined;
    }): (self: RequestResolver<A>) => Effect.Effect<RequestResolver<A>>;
    <A extends Request.Any>(self: RequestResolver<A>, options: {
        readonly capacity: number;
        readonly strategy?: "lru" | "fifo" | undefined;
    }): Effect.Effect<RequestResolver<A>>;
};
```

## persisted

Wraps a request resolver with persistent storage for persistable requests.

Source: `effect@4.0.2/src/RequestResolver.ts:2084`.

Vivid `RequestResolver.persisted` matches: 0. No qualified match. Bare-name matches: 113. Aliased usage is unverified.

```ts
export declare const persisted: {
    <A extends Request.Request<any, Persistence.PersistenceError | Schema.SchemaError, any> & Persistable.Any>(options: {
        readonly storeId: string;
        readonly timeToLive?: ((exit: Request.Result<A>, request: A) => Duration.Input) | undefined;
        readonly staleWhileRevalidate?: ((exit: Request.Result<A>, request: A) => boolean) | undefined;
    }): (self: RequestResolver<A>) => Effect.Effect<RequestResolver<A>, never, Persistence.Persistence | Scope>;
    <A extends Request.Request<any, Persistence.PersistenceError | Schema.SchemaError, any> & Persistable.Any>(self: RequestResolver<A>, options: {
        readonly storeId: string;
        readonly timeToLive?: ((exit: Request.Result<A>, request: A) => Duration.Input) | undefined;
        readonly staleWhileRevalidate?: ((exit: Request.Result<A>, request: A) => boolean) | undefined;
    }): Effect.Effect<RequestResolver<A>, never, Persistence.Persistence | Scope>;
};
```
