# Request

Import `effect/Request`. Source `effect@4.0.2/src/Request.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 21. Module-name matches in Vivid: 101. apps/desktop/src/main/assets.test.ts:24, apps/desktop/src/main/assets.test.ts:37, apps/desktop/src/main/assets.test.ts:40

## Request

A `Request<A, E, R>` is a request from a data source for a value of type `A` that may fail with an `E` and have requirements of type `R`.

Source: `effect@4.0.2/src/Request.ts:53`.

Vivid `Request.Request` matches: 0. No qualified match. Bare-name matches: 101. Aliased usage is unverified.

```ts
export interface Request<out A, out E = never, out R = never> extends Variance<A, E, R> {
}
```

## Any

Alias for any `Request`, regardless of its success, error, or service requirements.

Source: `effect@4.0.2/src/Request.ts:74`.

Vivid `Request.Any` matches: 0. No qualified match. Bare-name matches: 35. Aliased usage is unverified.

```ts
export type Any = Request<any, any, any>;
```

## Variance

Variance marker carried by every `Request`.

Source: `effect@4.0.2/src/Request.ts:88`.

Vivid `Request.Variance` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Variance<out A, out E, out R> {
    readonly [TypeId]: {
        readonly _A: Types.Covariant<A>;
        readonly _E: Types.Covariant<E>;
        readonly _R: Types.Covariant<R>;
    };
}
```

## Constructor

The constructor type returned by `Request.of` and `Request.tagged`.

Source: `effect@4.0.2/src/Request.ts:127`.

Vivid `Request.Constructor` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface Constructor<R extends Request<any, any, any>, T extends keyof R = never> {
    (args: Types.VoidIfEmpty<Types.Simplify<Omit<R, T | keyof (Variance<any, any, any>)>>>): R;
}
```

## Error

A utility type to extract the error type from a `Request`.

Source: `effect@4.0.2/src/Request.ts:152`.

Vivid `Request.Error` matches: 0. No qualified match. Bare-name matches: 149. Aliased usage is unverified.

```ts
export type Error<T extends Request<any, any, any>> = [
    T
] extends [
    Request<infer _A, infer _E, infer _R>
] ? _E : never;
```

## Success

A utility type to extract the value type from a `Request`.

Source: `effect@4.0.2/src/Request.ts:176`.

Vivid `Request.Success` matches: 0. No qualified match. Bare-name matches: 102. Aliased usage is unverified.

```ts
export type Success<T extends Request<any, any, any>> = [
    T
] extends [
    Request<infer _A, infer _E, infer _R>
] ? _A : never;
```

## Services

A utility type to extract the requirements type from a `Request`.

Source: `effect@4.0.2/src/Request.ts:186`.

Vivid `Request.Services` matches: 0. No qualified match. Bare-name matches: 23. Aliased usage is unverified.

```ts
export type Services<T extends Request<any, any, any>> = [
    T
] extends [
    Request<infer _A, infer _E, infer _R>
] ? _R : never;
```

## Result

A utility type to extract the result type from a `Request`.

Source: `effect@4.0.2/src/Request.ts:211`.

Vivid `Request.Result` matches: 0. No qualified match. Bare-name matches: 522. Aliased usage is unverified.

```ts
export type Result<T extends Request<any, any, any>> = T extends Request<infer A, infer E, infer _R> ? Exit.Exit<A, E> : never;
```

## RequestPrototype

Prototype used by Effect's request constructors.

Source: `effect@4.0.2/src/Request.ts:237`.

Vivid `Request.RequestPrototype` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const RequestPrototype: Request<any, any, any>;
```

## isRequest

Checks whether a value is a `Request`.

Source: `effect@4.0.2/src/Request.ts:270`.

Vivid `Request.isRequest` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isRequest: (u: unknown) => u is Request<unknown, unknown, unknown>;
```

## of

Creates a constructor function for a specific Request type.

Source: `effect@4.0.2/src/Request.ts:305`.

Vivid `Request.of` matches: 0. No qualified match. Bare-name matches: 4359. Aliased usage is unverified.

```ts
export declare const of: <R extends Request<any, any, any>>() => Constructor<R>;
```

## tagged

Creates a constructor function for a tagged Request type. The tag is automatically added to the request, making it useful for discriminated unions.

Source: `effect@4.0.2/src/Request.ts:350`.

Vivid `Request.tagged` matches: 0. No qualified match. Bare-name matches: 27. Aliased usage is unverified.

```ts
export declare const tagged: <R extends Request<any, any, any> & {
    _tag: string;
}>(tag: R["_tag"]) => Constructor<R, "_tag">;
```

## Class

Defines request types with TypeScript classes.

Source: `effect@4.0.2/src/Request.ts:384`.

Vivid `Request.Class` matches: 1. apps/server/src/connections/effects.ts:187 Bare-name matches: 26. Aliased usage is unverified.

```ts
export declare const Class: new <A extends Record<string, any>, Success, Error = never, Context = never>(args: Types.Equals<Omit<A, keyof Request<unknown, unknown>>, {}> extends true ? void : {
    readonly [P in keyof A as P extends keyof Request<any, any, any> ? never : P]: A[P];
}) => Request<Success, Error, Context> & Readonly<A>;
```

## TaggedClass

Creates a class constructor for requests with a fixed `_tag` field.

Source: `effect@4.0.2/src/Request.ts:424`.

Vivid `Request.TaggedClass` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const TaggedClass: <Tag extends string>(tag: Tag) => new <A extends Record<string, any>, Success, Error = never, Services = never>(args: Types.Equals<Omit<A, keyof Request<unknown, unknown>>, {}> extends true ? void : {
    readonly [P in keyof A as P extends "_tag" | keyof Request<any, any, any> ? never : P]: A[P];
}) => Request<Success, Error, Services> & Readonly<A> & {
    readonly _tag: Tag;
};
```

## complete

Completes a request entry with the provided result.

Source: `effect@4.0.2/src/Request.ts:452`.

Vivid `Request.complete` matches: 1. apps/server/src/connections/effects.ts:316 Bare-name matches: 140. Aliased usage is unverified.

```ts
export declare const complete: {
    <A extends Any>(result: Result<A>): (self: Entry<A>) => Effect.Effect<void>;
    <A extends Any>(self: Entry<A>, result: Result<A>): Effect.Effect<void>;
};
```

## completeEffect

Completes a request entry with the result of an effect.

Source: `effect@4.0.2/src/Request.ts:521`.

Vivid `Request.completeEffect` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const completeEffect: {
    <A extends Any, R>(effect: Effect.Effect<Success<A>, Error<A>, R>): (self: Entry<A>) => Effect.Effect<void, never, R>;
    <A extends Any, R>(self: Entry<A>, effect: Effect.Effect<Success<A>, Error<A>, R>): Effect.Effect<void, never, R>;
};
```

## fail

Completes a request entry with a typed failure.

Source: `effect@4.0.2/src/Request.ts:602`.

Vivid `Request.fail` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: {
    <A extends Any>(error: Error<A>): (self: Entry<A>) => Effect.Effect<void>;
    <A extends Any>(self: Entry<A>, error: Error<A>): Effect.Effect<void>;
};
```

## failCause

Completes a request entry with a failure `Cause`.

Source: `effect@4.0.2/src/Request.ts:661`.

Vivid `Request.failCause` matches: 1. apps/server/src/connections/effects.ts:313 Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const failCause: {
    <A extends Any>(cause: Cause.Cause<Error<A>>): (self: Entry<A>) => Effect.Effect<void>;
    <A extends Any>(self: Entry<A>, cause: Cause.Cause<Error<A>>): Effect.Effect<void>;
};
```

## succeed

Completes a request entry successfully with the supplied value.

Source: `effect@4.0.2/src/Request.ts:721`.

Vivid `Request.succeed` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const succeed: {
    <A extends Any>(value: Success<A>): (self: Entry<A>) => Effect.Effect<void>;
    <A extends Any>(self: Entry<A>, value: Success<A>): Effect.Effect<void>;
};
```

## Entry

A pending request handed to a `RequestResolver`.

Source: `effect@4.0.2/src/Request.ts:777`.

Vivid `Request.Entry` matches: 0. No qualified match. Bare-name matches: 37. Aliased usage is unverified.

```ts
export interface Entry<out R> {
    readonly request: R;
    readonly context: Context.Context<[
        R
    ] extends [
        Request<infer _A, infer _E, infer _R>
    ] ? _R : never>;
    uninterruptible: boolean;
    completeUnsafe(exit: Exit.Exit<[
        R
    ] extends [
        Request<infer _A, infer _E, infer _R>
    ] ? _A : never, [
        R
    ] extends [
        Request<infer _A, infer _E, infer _R>
    ] ? _E : never>): void;
}
```

## makeEntry

Creates a `Request.Entry` from its component fields.

Source: `effect@4.0.2/src/Request.ts:804`.

Vivid `Request.makeEntry` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeEntry: <R>(options: {
    readonly request: R;
    readonly context: Context.Context<[
        R
    ] extends [
        Request<infer _A, infer _E, infer _R>
    ] ? _R : never>;
    readonly uninterruptible: boolean;
    readonly completeUnsafe: (exit: Exit.Exit<[
        R
    ] extends [
        Request<infer _A, infer _E, infer _R>
    ] ? _A : never, [
        R
    ] extends [
        Request<infer _A, infer _E, infer _R>
    ] ? _E : never>) => void;
}) => Entry<R>;
```
