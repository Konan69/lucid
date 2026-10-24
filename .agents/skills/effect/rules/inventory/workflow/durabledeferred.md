# DurableDeferred

Import `effect/workflow/DurableDeferred`. Source `effect@4.0.2/src/workflow/DurableDeferred.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 17. Module-name matches in Vivid: 0. No bare-name match.

## DurableDeferred

Named durable deferred value whose completion is persisted by the workflow engine and encoded with success and error schemas.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:40`.

Vivid `DurableDeferred.DurableDeferred` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DurableDeferred<Success extends Schema.Constraint, Error extends Schema.Constraint = Schema.Never> {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly successSchema: Success;
    readonly errorSchema: Error;
    readonly exitSchema: Schema.Exit<Schema.Top, Schema.Top, Schema.Top>;
    readonly withActivityAttempt: Effect.Effect<DurableDeferred<Success, Error>>;
}
```

## Any

Type-erased durable deferred shape for APIs that only need the deferred identity and name.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:60`.

Vivid `DurableDeferred.Any` matches: 0. No qualified match. Bare-name matches: 35. Aliased usage is unverified.

```ts
export interface Any {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
}
```

## AnyWithProps

Type-erased durable deferred shape that also exposes success, error, and exit schemas.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:73`.

Vivid `DurableDeferred.AnyWithProps` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface AnyWithProps {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly successSchema: Schema.Top;
    readonly errorSchema: Schema.Top;
    readonly exitSchema: Schema.Exit<any, any, any>;
}
```

## make

Creates a named durable deferred with optional success and error schemas for persisted completion.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:89`.

Vivid `DurableDeferred.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: <Success extends Schema.Constraint = Schema.Void, Error extends Schema.Constraint = Schema.Never>(name: string, options?: {
    readonly success?: Success | undefined;
    readonly error?: Error | undefined;
}) => DurableDeferred<Success, Error>;
```

## await

Waits for the durable deferred, suspending the current workflow when no persisted completion is available.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:176`.

Vivid `DurableDeferred.await` matches: 0. No qualified match. Bare-name matches: 395. Aliased usage is unverified.

```ts
declare const await_: <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Effect.Effect<Success["Type"], Error["Type"], WorkflowEngine | WorkflowInstance | Success["DecodingServices"] | Error["DecodingServices"]>;
export { await_ as await };
```

## into

Runs an effect and records its exit into the durable deferred, resuming workflows that are waiting on that deferred.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:187`.

Vivid `DurableDeferred.into` matches: 0. No qualified match. Bare-name matches: 417. Aliased usage is unverified.

```ts
export declare const into: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>): <R>(effect: Effect.Effect<Success["Type"], Error["Type"], R>) => Effect.Effect<Success["Type"], Error["Type"], R | WorkflowEngine | WorkflowInstance | Success["DecodingServices"] | Error["DecodingServices"] | Success["EncodingServices"] | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint, R>(effect: Effect.Effect<Success["Type"], Error["Type"], R>, self: DurableDeferred<Success, Error>): Effect.Effect<Success["Type"], Error["Type"], R | WorkflowEngine | WorkflowInstance | Success["DecodingServices"] | Error["DecodingServices"] | Success["EncodingServices"] | Error["EncodingServices"]>;
};
```

## raceAll

Runs effects as a durable race, returning a previously persisted result when present or completing a named deferred with the first result.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:291`.

Vivid `DurableDeferred.raceAll` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const raceAll: <const Effects extends NonEmptyReadonlyArray<Effect.Effect<any, any, any>>, Success extends Schema.Schema<Effect.Success<Effects[number]>>, Error extends Schema.Schema<Effect.Error<Effects[number]>>>(options: {
    name: string;
    success: Success;
    error: Error;
    effects: Effects;
}) => Effect.Effect<Effect.Success<Effects[number]>, Effect.Error<Effects[number]>, Effect.Services<Effects[number]> | Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"] | WorkflowEngine | WorkflowInstance>;
```

## TokenTypeId

Type-level brand identifier for `Token` values.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:344`.

Vivid `DurableDeferred.TokenTypeId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const TokenTypeId = "~effect/workflow/DurableDeferred/Token";
export type TokenTypeId = typeof TokenTypeId;
```

## Token

Schema for branded durable deferred tokens.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:363`.

Vivid `DurableDeferred.Token` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export type Token = Brand.Branded<string, TokenTypeId>;
export declare const Token: Schema.brand<Schema.String, TokenTypeId>;
```

## TokenParsed

Schema for a decoded durable deferred token containing the workflow name, execution ID, and deferred name.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:373`.

Vivid `DurableDeferred.TokenParsed` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class TokenParsed extends TokenParsed_base {
    get asToken(): Token;
    static readonly FromString: Schema.decodeTo<typeof TokenParsed, Schema.decodeTo<Schema.fromJsonString<Schema.Tuple<readonly [
        Schema.String,
        Schema.String,
        Schema.String
    ]>>, Schema.String, never, never>, never, never>;
    static readonly fromString: (input: string, options?: import("../SchemaAST.ts").ParseOptions) => TokenParsed;
    static readonly encode: (input: TokenParsed, options?: import("../SchemaAST.ts").ParseOptions) => string;
}
```

## token

Creates a token for a durable deferred using the current workflow instance's workflow name and execution ID.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:453`.

Vivid `DurableDeferred.token` matches: 0. No qualified match. Bare-name matches: 493. Aliased usage is unverified.

```ts
export declare const token: <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Effect.Effect<Token, never, WorkflowInstance>;
```

## tokenFromExecutionId

Creates a durable deferred token from an explicit workflow, execution ID, and deferred name.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:472`.

Vivid `DurableDeferred.tokenFromExecutionId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const tokenFromExecutionId: {
    (options: {
        readonly workflow: Workflow.Any;
        readonly executionId: string;
    }): <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Token;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly workflow: Workflow.Any;
        readonly executionId: string;
    }): Token;
};
```

## tokenFromPayload

Creates a durable deferred token by deriving the workflow execution ID from the supplied workflow payload.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:525`.

Vivid `DurableDeferred.tokenFromPayload` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const tokenFromPayload: {
    <W extends Workflow.Any>(options: {
        readonly workflow: W;
        readonly payload: Workflow.PayloadSchema<W>["~type.make.in"];
    }): <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>) => Effect.Effect<Token>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint, W extends Workflow.Any>(self: DurableDeferred<Success, Error>, options: {
        readonly workflow: W;
        readonly payload: Workflow.PayloadSchema<W>["~type.make.in"];
    }): Effect.Effect<Token>;
};
```

## done

Completes the durable deferred identified by a token with the supplied exit, encoding the result through the deferred schemas.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:589`.

Vivid `DurableDeferred.done` matches: 0. No qualified match. Bare-name matches: 433. Aliased usage is unverified.

```ts
export declare const done: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>;
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"] | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>;
    }): Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"] | Error["EncodingServices"]>;
};
```

## succeed

Completes the durable deferred identified by a token with a successful value.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:660`.

Vivid `DurableDeferred.succeed` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const succeed: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly value: Success["Type"];
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly value: Success["Type"];
    }): Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]>;
};
```

## fail

Completes the durable deferred identified by a token with a typed failure.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:714`.

Vivid `DurableDeferred.fail` matches: 0. No qualified match. Bare-name matches: 783. Aliased usage is unverified.

```ts
export declare const fail: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly error: Error["Type"];
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly error: Error["Type"];
    }): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>;
};
```

## failCause

Completes the durable deferred identified by a token with a failure cause.

Source: `effect@4.0.2/src/workflow/DurableDeferred.ts:766`.

Vivid `DurableDeferred.failCause` matches: 0. No qualified match. Bare-name matches: 5. Aliased usage is unverified.

```ts
export declare const failCause: {
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
        readonly token: Token;
        readonly cause: Cause.Cause<Error["Type"]>;
    }): (self: DurableDeferred<Success, Error>) => Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>;
    <Success extends Schema.Constraint, Error extends Schema.Constraint>(self: DurableDeferred<Success, Error>, options: {
        readonly token: Token;
        readonly cause: Cause.Cause<Error["Type"]>;
    }): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>;
};
```
