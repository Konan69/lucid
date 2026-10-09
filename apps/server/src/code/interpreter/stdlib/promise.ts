/** Ported from opencode `packages/codemode/src/stdlib/promise.ts` at 3884062 (MIT). */
import type { PromiseMethodName } from "../model.ts"

export const promiseStatics = new Set<PromiseMethodName>(["all", "allSettled", "race", "resolve", "reject"])

/** Maximum number of eagerly forked tool calls that may run concurrently. */
export const TOOL_CALL_CONCURRENCY = 8
