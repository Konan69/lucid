import * as NodeFS from 'node:fs'
import NodeProcess from 'node:process'
import * as Schema from 'effect/Schema'
import { NativeMode, RECEIPT_FD } from './mode.ts'

/** `fork` builds argv as `[execPath, modulePath, ...args]` (Node v24.14.1 lib/child_process.js:160). */
const mode = Schema.decodeUnknownSync(NativeMode)(NodeProcess.argv[2])

/**
 * Retained ordinary objects exhaust V8's old generation, which is what `--max-old-space-size` caps;
 * typed-array backing stores would not. The loop never yields, so no exit can come before the abort.
 */
const grow = (): void => {
  const retained: Array<ReadonlyArray<{ value: number }>> = []
  for (;;) retained.push(Array.from({ length: 10_000 }, (_, value) => ({ value })))
}

/**
 * A `disconnect` listener references the IPC channel (lib/child_process.js:183-185), so the event
 * loop stays alive with no timer. The same listener ends the process if its parent disappears, so a
 * dead test runner leaves no orphan.
 */
const idle = (): void => {
  NodeProcess.once('disconnect', () => NodeProcess.exit(0))
}

const acts: Record<typeof NativeMode.Type, () => void> = {
  grow,
  abort: () => NodeProcess.abort(),
  exit: () => NodeProcess.exit(1),
  idle,
}

/**
 * The receipt is written by this module's own code, after the loader and the argv decode. A process
 * that died earlier closes the pipe without data, so the test tells "ran, then ended" from "never ran".
 */
NodeFS.writeSync(RECEIPT_FD, 'entered')
acts[mode]()
