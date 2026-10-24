import * as Schema from 'effect/Schema'

/** The parent starts the production entry only after dependency preparation has completed. */
export const StartupRequest = Schema.TaggedUnion({ Run: {} })

/** Readiness means the runtime dependency graph is evaluated, while main.ts is still unexecuted. */
export const StartupReceipt = Schema.TaggedUnion({ Ready: {} })
