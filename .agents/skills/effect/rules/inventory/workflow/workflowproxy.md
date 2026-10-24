# WorkflowProxy

Import `effect/workflow/WorkflowProxy`. Source `effect@4.0.2/src/workflow/WorkflowProxy.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## toRpcGroup

Derives an `RpcGroup` from a list of workflows.

Source: `effect@4.0.2/src/workflow/WorkflowProxy.ts:57`.

Vivid `WorkflowProxy.toRpcGroup` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toRpcGroup: <const Workflows extends NonEmptyReadonlyArray<Workflow.Any>, const Prefix extends string = "">(workflows: Workflows, options?: {
    readonly prefix?: Prefix | undefined;
}) => RpcGroup.RpcGroup<ConvertRpcs<Workflows[number], Prefix>>;
```

## ConvertRpcs

Maps each workflow to the RPC definitions generated for execute, discard, and resume operations.

Source: `effect@4.0.2/src/workflow/WorkflowProxy.ts:95`.

Vivid `WorkflowProxy.ConvertRpcs` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type ConvertRpcs<Workflows extends Workflow.Any, Prefix extends string> = Workflows extends Workflow.Workflow<infer _Name, infer _Payload, infer _Success, infer _Error> ? Rpc.Rpc<`${Prefix}${_Name}`, _Payload, _Success, _Error> | Rpc.Rpc<`${Prefix}${_Name}Discard`, _Payload, typeof Schema.String> | Rpc.Rpc<`${Prefix}${_Name}Resume`, typeof ResumePayload> : never;
```

## toHttpApiGroup

Derives an `HttpApiGroup` from a list of workflows.

Source: `effect@4.0.2/src/workflow/WorkflowProxy.ts:146`.

Vivid `WorkflowProxy.toHttpApiGroup` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toHttpApiGroup: <const Name extends string, const Workflows extends NonEmptyReadonlyArray<Workflow.Any>>(name: Name, workflows: Workflows) => HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<Workflows[number]>>;
```

## ConvertHttpApi

Maps each workflow to the HTTP API endpoints generated for execute, discard, and resume operations.

Source: `effect@4.0.2/src/workflow/WorkflowProxy.ts:186`.

Vivid `WorkflowProxy.ConvertHttpApi` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type ConvertHttpApi<Workflows extends Workflow.Any> = Workflows extends Workflow.Workflow<infer _Name, infer _Payload, infer _Success, infer _Error> ? HttpApiEndpoint.HttpApiEndpoint<_Name, "POST", `/${Lowercase<_Name>}`, never, never, _Payload, never, _Success, _Error> | HttpApiEndpoint.HttpApiEndpoint<`${_Name}Discard`, "POST", `/${Lowercase<_Name>}/discard`, never, never, _Payload, never, typeof Schema.String> | HttpApiEndpoint.HttpApiEndpoint<`${_Name}Resume`, "POST", `/${Lowercase<_Name>}/resume`, never, never, typeof ResumePayload> : never;
```
