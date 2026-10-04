import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import {
  ExtractionLimitExceeded,
  ExtractionRpcs,
  ExtractionUnavailable,
} from './extraction/contract.ts'

/** The process adapter owns startup admission and its closed configuration failure vocabulary. */
export {
  ExtractionConfigurationError,
  admission as extractionAdmission,
} from './extraction/process.ts'
import {
  type Launch,
  ProcessEnd,
  type Running,
  forkExtractor,
  heapEvidence,
  layer,
  start,
  stop,
} from './extraction/process.ts'

/** The server's names for the extraction vocabulary; the leaf module is their one declaration. */
export {
  ExtractionFaulted,
  ExtractionLimitExceeded,
  ExtractionRpcs,
  ExtractionUnavailable,
  PdfLocked,
  PdfUnreadable,
} from './extraction/contract.ts'

/** Chosen policy, not a measured pdf.js budget; it includes spawn, loader and protocol handshake. */
export const EXTRACTION_DEADLINE = Duration.seconds(60)
/**
 * Enforced as `--max-old-space-size` on the extraction process. Only V8's old generation is capped;
 * typed-array backing stores, native memory and so the process's RSS are not.
 */
export const EXTRACTION_HEAP_MB = 512

/** What the log may say about an end: the exit code or the signal name Node reported, nothing else. */
const reported = (end: typeof ProcessEnd.Type) =>
  ProcessEnd.match<Record<string, string | number>>(end, {
    Exited: ({ code }) => ({ code }),
    Signaled: ({ signal }) => ({ signal }),
    Unreported: () => ({}),
  })

/**
 * Turn a process end that this code did not cause into the extraction's failure.
 *
 * `heap` needs both facts: the process ended by `SIGABRT`, and its Node report names its pid and
 * V8's heap-OOM handler (`heapEvidence`). A bare `SIGABRT`, any other signal, any exit code and an
 * unreported end are `ExtractionUnavailable`, which the queue retries. The report is read only
 * here, after the end, and none of it is logged: the log carries the code or signal and the tag.
 */
const classify = Effect.fn('LibraryExtraction.classify')(function* (
  reportDir: string,
  pid: number,
  end: typeof ProcessEnd.Type,
) {
  const heap = yield* ProcessEnd.match<Effect.Effect<boolean, never, FileSystem.FileSystem>>(end, {
    Exited: () => Effect.succeed(false),
    Signaled: ({ signal }) =>
      signal === 'SIGABRT' ? heapEvidence(reportDir, pid) : Effect.succeed(false),
    Unreported: () => Effect.succeed(false),
  })
  yield* Effect.logWarning('Library extraction process ended').pipe(
    Effect.annotateLogs({ ...reported(end), evidence: heap ? 'heap' : 'none' }),
  )
  return yield* Effect.fail(
    heap ? new ExtractionLimitExceeded({ limit: 'heap' }) : new ExtractionUnavailable(),
  )
})

/**
 * The call produced no answer. If the process is known to have ended, its end decides; otherwise
 * the transport failed with the process still running, which is `ExtractionUnavailable`.
 * `Deferred.poll` reads the level-triggered end without waiting (Deferred.ts:1415-1417).
 */
const unanswered = Effect.fn('LibraryExtraction.unanswered')(function* (
  { pid, ended }: Running,
  reportDir: string,
) {
  const end = yield* Deferred.poll(ended)
  return yield* Option.match(end, {
    onNone: () => Effect.fail(new ExtractionUnavailable()),
    onSome: Effect.flatMap((observed) => classify(reportDir, pid, observed)),
  })
})

/**
 * Ask the process for the pages, on the official worker RPC: `RpcClient.makeProtocolWorker`
 * (RpcClient.ts:1254-1420) over the process's Worker platform, with the SDK's own framing.
 *
 * The protocol is built into the caller's outer Scope. `layer(running)` holds two plain values, so
 * providing it here owns no finalizer, and the SDK's fibers live until that outer scope closes,
 * after `stop`.
 *
 * The answer is raced with the native end. The race is required: the SDK forks its worker run and
 * retries a failed run after one second (RpcClient.ts:1337, 1343), and a request sent before
 * readiness sits in the SDK buffer (Worker.ts:234-241). A process that dies there fails no call by
 * itself. The end branch only signals "no answer"; so does a transport error. Both then go through
 * `unanswered`, so there is one classification and one log line, taken after the race.
 *
 * The bytes are copied before the call. The SDK may hold the request until the handshake, and Node
 * serializes at the later native `send`; the copy keeps the caller's buffer out of that window.
 * Nothing here ends the process or closes the SDK scope.
 */
const verdict = Effect.fn('LibraryExtraction.verdict')(function* (
  running: Running,
  reportDir: string,
  bytes: Uint8Array,
) {
  const protocol = yield* RpcClient.makeProtocolWorker({ size: 1 }).pipe(
    Effect.provide(layer(running)),
    Effect.catchTag('WorkerError', () => Effect.fail(new ExtractionUnavailable())),
  )
  const client = yield* RpcClient.make(ExtractionRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
  const pages = yield* Effect.raceFirst(
    Effect.asSome(client.ExtractPdf({ bytes: new Uint8Array(bytes) })),
    Effect.as(Deferred.await(running.ended), Option.none()),
  ).pipe(Effect.catchTag('RpcClientError', () => Effect.succeedNone))
  return yield* Option.match(pages, {
    onNone: () => unanswered(running, reportDir),
    onSome: (text) => Effect.succeed(text),
  })
})

/**
 * One extraction: report directory, process, decision, stop.
 *
 * Order, which the caller's `Effect.scoped` and `acquireUseRelease` fix (Effect.ts:13186-13190;
 * internal/effect.ts:4073-4082, 4346-4358):
 * 1. The report directory is made first in the scope, so it is removed last. A failure to make it
 *    is `ExtractionUnavailable`. Its removal is the SDK's scoped release, which dies on a failed
 *    removal (platform-node-shared rc.116 NodeFileSystem.ts:203-209). That defect is the SDK's;
 *    this code adds none.
 * 2. `start` forks and observes. A failed start releases nothing.
 * 3. The decision is taken while the process is untouched: an answer, a typed content failure, the
 *    end the process chose itself, or the deadline. `timeoutOrElse` interrupts the losing call and
 *    waits for it before it returns `time` (internal/effect.ts:1681-1690, 3806-3833, 3865-3880).
 * 4. `stop` then kills the group if it still runs and waits for the native exit. The end it causes
 *    arrives after the decision and cannot replace a success, a `time` verdict or an interruption.
 * 5. The scope closes: the SDK's fibers are interrupted, then the report directory is removed.
 */
const attempt = Effect.fn('LibraryExtraction.attempt')(function* (
  launch: Launch,
  deadline: Duration.Duration,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem
  const reportDir = yield* fs
    .makeTempDirectoryScoped({ prefix: 'vivid-extraction-' })
    .pipe(Effect.mapError(() => new ExtractionUnavailable()))
  return yield* Effect.acquireUseRelease(
    start(() => launch(reportDir)),
    (running) =>
      verdict(running, reportDir, bytes).pipe(
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () => Effect.fail(new ExtractionLimitExceeded({ limit: 'time' })),
        }),
      ),
    (running) => stop(running),
  )
})

/**
 * The public lifecycle over any launcher, so fixtures run real processes through exactly the code
 * production runs. It needs a `FileSystem` for the report directory and the report read.
 */
export const extractOn = (launch: Launch, deadline: Duration.Duration) =>
  Effect.fn('LibraryExtraction.extract')((bytes: Uint8Array) =>
    Effect.scoped(attempt(launch, deadline, bytes)),
  )

/** One fresh process per PDF; upload size, deadline and old-generation cap bound the work, not RSS. */
const extractByProcess = extractOn(forkExtractor(EXTRACTION_HEAP_MB), EXTRACTION_DEADLINE)

/** Production extraction on the Node file system, so callers keep an Effect with no requirement. */
export const extractPdf = (bytes: Uint8Array) =>
  extractByProcess(bytes).pipe(Effect.provide(NodeFileSystem.layer))
