# SqlError

Import `effect/sql/SqlError`. Source `effect@4.0.2/src/sql/SqlError.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 1. Module-name matches in Vivid: 12. apps/server/src/computers/boat/bindings.ts:4, apps/server/src/computers/boat/bindings.ts:33, apps/server/src/database/client.ts:9

## StatementTimeoutError

SQL error reason for a statement or query timeout; marked retryable.

Source: `effect@4.0.2/src/sql/SqlError.ts:310`.

Vivid `SqlError.StatementTimeoutError` matches: 0. No qualified match. Bare-name matches: 0. Aliased usage is unverified.

```ts
export declare class StatementTimeoutError extends StatementTimeoutError_base {
    readonly [ReasonTypeId]: "~effect/sql/SqlError/Reason";
    get isRetryable(): boolean;
}
```
