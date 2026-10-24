# Statement

Import `effect/sql/Statement`. Source `effect@4.0.2/src/sql/Statement.ts`.

Replacement candidates are in [the selection map](../../primitives.md#vivid-patterns). Getters, guards, type helpers, and unsafe adapter variants support their module; they do not each replace an independent lifecycle.

Distinct exports inventoried: 1. Module-name matches in Vivid: 9. apps/server/src/approvals/review.live.test.ts:86, apps/server/src/approvals/review.live.test.ts:98, apps/server/src/drafts/generation.test.ts:4

## Statement

Executable SQL statement that is also a `Fragment` and `Effect`, with helpers for raw execution, streaming, value rows, unprepared execution, no-transform execution, and compilation.

Source: `effect@4.0.2/src/sql/Statement.ts:76`.

Vivid `Statement.Statement` matches: 0. No qualified match. Bare-name matches: 9. Aliased usage is unverified.

```ts
export interface Statement<A> extends Fragment, Effect.Effect<ReadonlyArray<A>, SqlError> {
    readonly raw: Effect.Effect<unknown, SqlError>;
    readonly withoutTransform: Effect.Effect<ReadonlyArray<A>, SqlError>;
    readonly stream: Stream.Stream<A, SqlError>;
    readonly values: Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>;
    readonly valuesUnprepared: Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>;
    readonly unprepared: Effect.Effect<ReadonlyArray<A>, SqlError>;
    readonly compile: (withoutTransform?: boolean | undefined) => readonly [
        sql: string,
        params: ReadonlyArray<unknown>
    ];
}
```
