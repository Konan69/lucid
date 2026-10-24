# RunnerAddress

Import `effect/cluster/RunnerAddress`. Source `effect@4.0.2/src/cluster/RunnerAddress.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## RunnerAddress

Represents the network address of a cluster runner, identified by host and port.

Source: `effect@4.0.2/src/cluster/RunnerAddress.ts:31`.

Vivid `RunnerAddress.RunnerAddress` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class RunnerAddress extends RunnerAddress_base {
    readonly [TypeId] = "~effect/cluster/RunnerAddress";
    [Equal.symbol](that: RunnerAddress): boolean;
    [Hash.symbol](): number;
    [PrimaryKey.symbol](): string;
    toString(): string;
    [NodeInspectSymbol](): string;
}
```

## make

Constructs a `RunnerAddress` from a host and port.

Source: `effect@4.0.2/src/cluster/RunnerAddress.ts:120`.

Vivid `RunnerAddress.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (host: string, port: number) => RunnerAddress;
```
