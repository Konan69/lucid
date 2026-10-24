# WorkflowProxyServer

Import `effect/workflow/WorkflowProxyServer`. Source `effect@4.0.2/src/workflow/WorkflowProxyServer.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 3. Module-name matches in Vivid: 0. No bare-name match.

## layerHttpApi

Creates handlers for a workflow HTTP API group, wiring execute, discard, and resume endpoints to the supplied workflows.

Source: `effect@4.0.2/src/workflow/WorkflowProxyServer.ts:32`.

Vivid `WorkflowProxyServer.layerHttpApi` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerHttpApi: <ApiId extends string, Groups extends HttpApiGroup.Constraint, Identifier extends HttpApiGroup.Identifier<Groups>, const Workflows extends NonEmptyReadonlyArray<Workflow.Any>>(api: HttpApi.HttpApi<ApiId, Groups>, identifier: Identifier, workflows: Workflows) => Layer.Layer<HttpApiGroup.Service<ApiId, Identifier>, never, WorkflowEngine | Workflow.RequirementsHandler<Workflows[number]>>;
```

## layerRpcHandlers

Creates RPC handlers for the supplied workflows, wiring execute, discard, and resume RPCs to workflow operations.

Source: `effect@4.0.2/src/workflow/WorkflowProxyServer.ts:99`.

Vivid `WorkflowProxyServer.layerRpcHandlers` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerRpcHandlers: <const Workflows extends NonEmptyReadonlyArray<Workflow.Any>, const Prefix extends string = "">(workflows: Workflows, options?: {
    readonly prefix?: Prefix;
}) => Layer.Layer<RpcHandlers<Workflows[number], Prefix>, never, WorkflowEngine | Workflow.RequirementsHandler<Workflows[number]>>;
```

## RpcHandlers

Union of RPC handler services required to serve the generated workflow execute, discard, and resume RPCs.

Source: `effect@4.0.2/src/workflow/WorkflowProxyServer.ts:148`.

Vivid `WorkflowProxyServer.RpcHandlers` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type RpcHandlers<Workflows extends Workflow.Any, Prefix extends string> = Workflows extends Workflow.Workflow<infer _Name, infer _Payload, infer _Success, infer _Error> ? Rpc.Handler<`${Prefix}${_Name}`> | Rpc.Handler<`${Prefix}${_Name}Discard`> | Rpc.Handler<`${Prefix}${_Name}Resume`> : never;
```
