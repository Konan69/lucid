# MachineId

Import `effect/cluster/MachineId`. Source `effect@4.0.2/src/cluster/MachineId.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 2. Module-name matches in Vivid: 0. No bare-name match.

## MachineId

Branded integer type representing a cluster machine ID.

Source: `effect@4.0.2/src/cluster/MachineId.ts:33`.

Vivid `MachineId.MachineId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const MachineId: Schema.brand<Schema.Int, "~effect/cluster/MachineId">;
export type MachineId = typeof MachineId.Type;
```

## make

Brands a number as a `MachineId`.

Source: `effect@4.0.2/src/cluster/MachineId.ts:58`.

Vivid `MachineId.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (id: number) => MachineId;
```
