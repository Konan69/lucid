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

/**
 * The bound for a test that ends a real process with SIGABRT. The time such a process takes to end
 * is the host's, not ours: when the kernel pipes crashes to a handler (`kernel.core_pattern`
 * starting with `|`; WSL 2 does, and takes about five seconds per crash) the exit is reported only
 * after that handler returns. The runner's five-second default then fails a correct run. These
 * tests still wait on the process's own end and never sleep; this only stops the default from
 * racing the host.
 */
export const CRASH_TIMEOUT_MS = 30_000
