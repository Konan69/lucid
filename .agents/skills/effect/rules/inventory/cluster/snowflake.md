# Snowflake

Import `effect/cluster/Snowflake`. Source `effect@4.0.2/src/cluster/Snowflake.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 14. Module-name matches in Vivid: 0. No bare-name match.

## TypeId

Type-level representation of the cluster snowflake brand identifier.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:41`.

Vivid `Snowflake.TypeId` matches: 0. No qualified match. Bare-name matches: 1. Aliased usage is unverified.

```ts
export declare const TypeId = "~effect/cluster/Snowflake";
export type TypeId = typeof TypeId;
```

## Snowflake

Namespace containing support types for snowflake parts and generators.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:70`.

Vivid `Snowflake.Snowflake` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export type Snowflake = Brand.Branded<bigint, TypeId>;
export declare const Snowflake: (input: string | number | bigint) => Snowflake;
export declare namespace Snowflake {
    interface Parts {
        readonly timestamp: number;
        readonly machineId: MachineId;
        readonly sequence: number;
    }
    interface Generator {
        readonly nextUnsafe: () => Snowflake;
        readonly setMachineId: (machineId: MachineId) => Effect.Effect<void>;
    }
}
```

## SnowflakeFromBigInt

Schema for snowflake ids represented as branded bigints.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:115`.

Vivid `Snowflake.SnowflakeFromBigInt` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SnowflakeFromBigInt extends Schema.brand<Schema.BigInt, TypeId> {
}
export declare const SnowflakeFromBigInt: SnowflakeFromBigInt;
```

## SnowflakeFromString

Schema that decodes snowflake ids from strings into branded bigints and encodes them back to strings.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:134`.

Vivid `Snowflake.SnowflakeFromString` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface SnowflakeFromString extends Schema.decodeTo<SnowflakeFromBigInt, Schema.String> {
}
export declare const SnowflakeFromString: SnowflakeFromString;
```

## constEpochMillis

Defines the custom snowflake epoch in Unix milliseconds.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:145`.

Vivid `Snowflake.constEpochMillis` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const constEpochMillis: number;
```

## make

Creates a branded snowflake id from a timestamp, machine id, and sequence number, using the custom snowflake epoch and 10-bit machine id and 12-bit sequence fields.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:175`.

Vivid `Snowflake.make` matches: 0. No qualified match. Bare-name matches: 4616. Aliased usage is unverified.

```ts
export declare const make: (options: {
    readonly machineId: MachineId;
    readonly sequence: number;
    readonly timestamp: number;
}) => Snowflake;
```

## timestamp

Extracts the Unix timestamp in milliseconds from a snowflake id.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:191`.

Vivid `Snowflake.timestamp` matches: 0. No qualified match. Bare-name matches: 245. Aliased usage is unverified.

```ts
export declare const timestamp: (snowflake: Snowflake) => number;
```

## dateTime

Extracts the timestamp from a snowflake id as a `DateTime.Utc`.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:200`.

Vivid `Snowflake.dateTime` matches: 0. No qualified match. Bare-name matches: 2. Aliased usage is unverified.

```ts
export declare const dateTime: (snowflake: Snowflake) => DateTime.Utc;
```

## machineId

Extracts the machine id component from a snowflake id.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:209`.

Vivid `Snowflake.machineId` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const machineId: (snowflake: Snowflake) => MachineId;
```

## sequence

Extracts the per-machine sequence component from a snowflake id.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:219`.

Vivid `Snowflake.sequence` matches: 0. No qualified match. Bare-name matches: 28. Aliased usage is unverified.

```ts
export declare const sequence: (snowflake: Snowflake) => number;
```

## toParts

Decomposes a snowflake id into its timestamp, machine id, and sequence parts.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:228`.

Vivid `Snowflake.toParts` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const toParts: (snowflake: Snowflake) => Snowflake.Parts;
```

## makeGenerator

Creates a stateful snowflake generator using `Clock`.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:247`.

Vivid `Snowflake.makeGenerator` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const makeGenerator: Effect.Effect<Snowflake.Generator>;
```

## Generator

Context service for a stateful snowflake id generator.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:292`.

Vivid `Snowflake.Generator` matches: 0. No qualified match. Bare-name matches: 12. Aliased usage is unverified.

```ts
export declare class Generator extends Generator_base {
}
```

## layerGenerator

Layer that provides the default snowflake `Generator` service.

Source: `effect@4.0.2/src/cluster/Snowflake.ts:304`.

Vivid `Snowflake.layerGenerator` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const layerGenerator: Layer.Layer<Generator>;
```
