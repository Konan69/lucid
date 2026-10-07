import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeStream from 'node:stream'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { EXTRACTION_DEADLINE, extractOn, type extractPdf } from '../extraction.ts'
import { type Launch, processOptions } from '../extraction/process.ts'
import { type Fixture, FixtureArgument } from './mode.ts'
import { RECEIPT_FD } from './process/mode.ts'

const encodeFixture = Schema.encodeSync(FixtureArgument)

/** Fixture budget only: a real heap death needs a small cap, not the 512 MB production policy. */
export const GROW_HEAP_MB = 64

/** How the test's own `exit` listener saw one process end. */
interface Ended {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/**
 * Launch one real fixture process through the production fork options plus one receipt pipe, and
 * record three native receipts for that process alone. Every listener is added in the same
 * synchronous step as `fork`, so no event is missed, and nothing is shared through memory.
 * - `entered`: true when the RPC handler wrote to the pipe, false when the pipe closed without data
 *   (no handler-entry write was observed; not every fixture handler writes a receipt).
 * - `ended`: the code or signal of the native `exit`.
 * - `reportDir`: the directory the lifecycle created for this process.
 * The test never signals a process; only the adapter under test does.
 */
export const nativeLaunch = (input: typeof Fixture.Type, heapMb: number) => {
  const entered = Deferred.makeUnsafe<boolean>()
  const ended = Deferred.makeUnsafe<Ended>()
  const reportDir = Deferred.makeUnsafe<string>()
  // Native callbacks use the rc.116 Deferred.doneUnsafe boundary; the first pipe receipt wins.
  const settle = (value: boolean) => () => {
    Deferred.doneUnsafe(entered, Effect.succeed(value))
  }
  // Resolve the fixture entry beside this launcher; production options still own IPC and heap reports.
  const launch: Launch = (directory) => {
    const options = processOptions({ heapMb, reportDir: directory })
    const child = NodeChildProcess.fork(
      new URL('./main.ts', import.meta.url),
      [encodeFixture(input)],
      { ...options, stdio: [...options.stdio, 'pipe'] },
    )
    const receipt = child.stdio[RECEIPT_FD]
    if (receipt instanceof NodeStream.Readable) {
      receipt.once('data', settle(true))
      receipt.once('close', settle(false))
      receipt.once('error', settle(false))
    } else {
      settle(false)()
    }
    child.once('exit', (code, signal) => {
      Deferred.doneUnsafe(ended, Effect.succeed({ code, signal }))
    })
    Deferred.doneUnsafe(reportDir, Effect.succeed(directory))
    return child
  }
  return { launch, entered, ended, reportDir }
}

/** Use the fixture launcher with the same file-system requirement as production extraction. */
export const extractWith = (launch: Launch): typeof extractPdf =>
  extractOn(launch, EXTRACTION_DEADLINE)

/** The report directory must not outlive its extraction, whatever the verdict was. */
export const reportRemoved = (owned: ReturnType<typeof nativeLaunch>) =>
  Effect.map(Deferred.await(owned.reportDir), (directory) => !NodeFS.existsSync(directory))
