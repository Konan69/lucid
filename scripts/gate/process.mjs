import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeEvents from 'node:events'
import * as NodeFS from 'node:fs'
import * as Schema from 'effect/Schema'

/**
 * A name for one gate run: its database, its log directory and its verdict carry it, so a
 * result can only ever be read by the invocation that started it.
 */
export function runIdentifier() {
  return `${Date.now().toString(36)}${NodeCrypto.randomBytes(3).toString('hex')}`
}

/** Every child the gate has started and not yet seen end, by the process id spawn returned. */
const running = new Set()

/**
 * A gate that is told to stop takes its children with it. Each child leads a process group of
 * its own (`detached`), so Turbo's tasks and Vitest's workers end too; without this a stopped
 * gate freed its locks while its children still wrote into the tree. `finally` blocks do not run
 * on a signal, so the caller's cleanup is given here.
 */
export function stopChildrenOnSignal(cleanup) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.once(signal, () => {
      for (const child of running) {
        try {
          process.kill(-child, 'SIGTERM')
        } catch {
          // The group ended between its last output and this signal.
        }
      }
      void cleanup().finally(() => process.exit(1))
    })
}

/** Run one command to completion with its output in a log file; resolves with exit and time. */
export async function logged(command, options) {
  const started = Date.now()
  const log = NodeFS.openSync(options.log, 'a')
  const child = NodeChildProcess.spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', log, log],
    detached: true,
  })
  if (child.pid !== undefined) running.add(child.pid)
  try {
    // `once` rejects when the child emits `error`, which is how a missing program reports.
    const [code] = await NodeEvents.once(child, 'close')
    return { exit: code === null ? 1 : code, seconds: (Date.now() - started) / 1000 }
  } catch (error) {
    NodeFS.writeSync(log, `could not start ${command.join(' ')}: ${error.message}\n`)
    return { exit: 1, seconds: (Date.now() - started) / 1000 }
  } finally {
    if (child.pid !== undefined) running.delete(child.pid)
    NodeFS.closeSync(log)
  }
}

/** The counts the gate reads from Vitest's JSON reporter; the rest of the file is not used. */
const TestCounts = Schema.Struct({
  numTotalTests: Schema.Number,
  numPendingTests: Schema.Number,
  numTodoTests: Schema.Number,
  testResults: Schema.Array(Schema.Unknown),
})
const decodeTestCounts = Schema.decodeUnknownSync(Schema.fromJsonString(TestCounts))

/** Tests, skipped tests and files of one Vitest result file; nothing when it was not written. */
export function readTestCounts(file) {
  if (!NodeFS.existsSync(file)) return { tests: 0, skipped: 0, files: 0 }
  const result = decodeTestCounts(NodeFS.readFileSync(file, 'utf8'))
  return {
    tests: result.numTotalTests,
    skipped: result.numPendingTests + result.numTodoTests,
    files: result.testResults.length,
  }
}
