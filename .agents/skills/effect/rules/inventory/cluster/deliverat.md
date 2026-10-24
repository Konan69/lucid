# DeliverAt

Import `effect/cluster/DeliverAt`. Source `effect@4.0.2/src/cluster/DeliverAt.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 4. Module-name matches in Vivid: 0. No bare-name match.

## symbol

Defines the property key used by values that provide a scheduled delivery time.

Source: `effect@4.0.2/src/cluster/DeliverAt.ts:25`.

Vivid `DeliverAt.symbol` matches: 0. No qualified match. Bare-name matches: 31. Aliased usage is unverified.

```ts
export declare const symbol = "~effect/cluster/DeliverAt";
```

## DeliverAt

Interface for payloads that specify when a cluster message should be delivered by returning the target delivery `DateTime` through the `DeliverAt` symbol method.

Source: `effect@4.0.2/src/cluster/DeliverAt.ts:36`.

Vivid `DeliverAt.DeliverAt` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export interface DeliverAt {
    [symbol](): DateTime;
}
```

## isDeliverAt

Returns `true` if the value implements the `DeliverAt` scheduled-delivery protocol.

Source: `effect@4.0.2/src/cluster/DeliverAt.ts:48`.

Vivid `DeliverAt.isDeliverAt` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare const isDeliverAt: (self: unknown) => self is DeliverAt;
```

## toMillis

Returns the scheduled delivery time in epoch milliseconds when the value implements `DeliverAt`, or `null` otherwise.

Source: `effect@4.0.2/src/cluster/DeliverAt.ts:58`.

Vivid `DeliverAt.toMillis` matches: 0. No qualified match. Bare-name matches: 11. Aliased usage is unverified.

```ts
export declare const toMillis: (self: unknown) => number | null;
```
