import * as Schema from 'effect/Schema'

/**
 * One vocabulary owns the test's argv and the native fixture's decoded ingress. Each mode is one
 * way a real process ends: V8 heap exhaustion, a bare abort, an ordinary exit, or no end of its own.
 */
export const NativeMode = Schema.Literals(['grow', 'abort', 'exit', 'idle'])

/**
 * Fixture-only descriptor. Production stdio is `[ignore, ignore, ignore, ipc]`; the test appends one
 * pipe, so the receipt never shares the IPC channel that the Worker protocol will own.
 */
export const RECEIPT_FD = 4
