# Runner

Import `effect/cluster/Runner`. Source `effect@4.0.2/src/cluster/Runner.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 4. apps/server/src/code/computer.ts:68, apps/server/src/code/computer.ts:78, apps/server/src/code/computer.ts:112

## Runner

Represents a cluster runner that can host entities.

Source: `effect@4.0.2/src/cluster/Runner.ts:31`.

Vivid `Runner.Runner` matches: 0. No qualified match. Bare-name matches: 4. Aliased usage is unverified.

```ts
export declare class Runner extends Runner_base {
    static format: import("../Formatter.ts").Formatter<Runner, string>;
    readonly [TypeId] = "~effect/cluster/Runner";
    static readonly decodeSync: (input: string, options?: import("../SchemaAST.ts").ParseOptions) => Runner;
    static readonly encodeSync: (input: Runner, options?: import("../SchemaAST.ts").ParseOptions) => string;
    toString(): string;
    [NodeInspectSymbol](): string;
    [Equal.symbol](that: Runner): boolean;
    [Hash.symbol](): number;
}
```

## make

Constructs a `Runner` from its network address, shard groups, and relative shard-assignment weight.

Source: `effect@4.0.2/src/cluster/Runner.ts:136`.

Vivid `Runner.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (props: {
    readonly address: RunnerAddress;
    readonly groups: ReadonlyArray<string>;
    readonly weight: number;
}) => Runner;
```
