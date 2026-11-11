import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as Array from 'effect/Array'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Runtime from 'effect/Runtime'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as Worker from 'effect/workers/Worker'
import { WorkerError, WorkerReceiveError } from 'effect/workers/WorkerError'
import { ExtractionUnavailable } from './contract.ts'

/**
 * How one extraction process ended, as Node reported it. `exit` carries exactly one of a code or a
 * signal (Node v24.14.1 lib/internal/child_process.js:270-275, 294). The listener's type also allows
 * neither; that case is kept as `Unreported` instead of being folded into a code or a signal.
 */
export const ProcessEnd = Schema.TaggedUnion({
  Exited: { code: Schema.Int },
  Signaled: { signal: Schema.String },
  Unreported: {},
})

/** What the Worker platform hands every message of the process to; the SDK's `emit` fits it. */
type Emit = (message: NodeChildProcess.Serializable) => void

/**
 * The messages of one process, level-triggered. A `ChildProcess` is an `EventEmitter`: a `message`
 * emitted while nothing listens is lost, and Node keeps no record of it. The inbox listens from the
 * spawn tick and holds every message, in arrival order, until a reader attaches; `attach` first
 * hands over what was held, then every later message directly. After `detach` it holds again, so a
 * second reader loses nothing either. Messages pass through unread: the framing belongs to the SDK.
 */
interface Inbox {
  readonly attach: (emit: Emit) => void
  readonly detach: () => void
}

/**
 * One started extraction process. `pid` is the id captured at spawn, always above 1, and is the only
 * id `stop` ever signals. `ended` and `inbox` are level-triggered: the native `exit` and every native
 * `message` are captured from the spawn tick, so a reader that arrives later still sees them.
 * `child` is kept for `send` and for the `error` listener of the Worker platform only.
 */
export interface Running {
  readonly child: NodeChildProcess.ChildProcess
  readonly pid: number
  readonly ended: Deferred.Deferred<typeof ProcessEnd.Type>
  readonly inbox: Inbox
}

/** Builds one process for one extraction and is told where that process must write its report. */
export type Launch = (reportDir: string) => NodeChildProcess.ChildProcess

/** Fixed name, so the parent reads one known path and never lists the report directory. */
const REPORT_FILE = 'report.json'

/**
 * Upper bound on what the parent reads from the report. `FileSystem.stream` stops at `bytesToRead`
 * (effect rc.116 FileSystem.ts:526-541), so the bound holds before any allocation and does not
 * depend on a size read earlier. A longer file is cut short, fails to parse and is no evidence.
 */
const REPORT_READ_BYTES = 1024 * 1024

/**
 * Options for `child_process.fork`, the one source of truth for production and for fixtures.
 *
 * - `--max-old-space-size` enforces the heap policy. It caps V8's old generation only, not RSS.
 * - The six report flags make Node write a diagnostic report when a fatal error ends the process
 *   (src/node_options.cc:1125-1133, 1284-1301). `--report-dir` and `--report-filename` fix its path
 *   (src/node_report.cc:833-852, 876-883). The report lists the command line, cwd, native stack,
 *   heap statistics, libuv handles and shared objects. Environment variables and network interfaces
 *   are excluded by flag (node_report.cc:258, 314). It is not claimed to be free of document
 *   content: `heapEvidence` reads three header fields and nothing here logs the file.
 * - `serialization: 'advanced'` keeps a `Uint8Array` intact over IPC; the default JSON mode does not.
 * - `detached: true` makes the child call `setsid` (deps/uv/src/unix/process.c:317-318), so its pid
 *   is also its process group id and `stop` can signal the group. POSIX only.
 * - stdout and stderr are `'ignore'`: no child output reaches the parent's memory or logs.
 *
 * Inherited flags: the parent's `execArgv` comes first and is passed on whole, because it carries
 * the TypeScript loader (tsx, Vitest). For an option passed more than once the last value wins
 * (doc/api/cli.md:61-64, also over `NODE_OPTIONS`, cli.md:3410; V8 flags.cc:126-214).
 * Node appends a percentage-derived old-generation size after those V8 arguments on every parse
 * pass (src/node.cc:764-768), overriding our flag. `capStanding` refuses that source and forms
 * whose effective options cannot be established without parsing quotes or reading files.
 * A parent `--report-uncaught-exception` or `--report-on-signal` is inherited
 * and can write a report with another trigger into the same directory; `heapEvidence` rejects it.
 */
export const processOptions = ({
  heapMb,
  reportDir,
}: {
  readonly heapMb: number
  readonly reportDir: string
}) =>
  ({
    execArgv: [
      ...NodeProcess.execArgv,
      `--max-old-space-size=${heapMb}`,
      '--report-on-fatalerror',
      '--report-compact',
      '--report-exclude-env',
      '--report-exclude-network',
      `--report-dir=${reportDir}`,
      `--report-filename=${REPORT_FILE}`,
    ],
    serialization: 'advanced',
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }) satisfies NodeChildProcess.ForkOptions

/**
 * The production launcher: one fresh process per PDF on the production entry. The production entry
 * path and fork call live here, while test fixtures supply their own launchers. The heap policy is
 * passed in by its owner. Script arguments stay empty: Node's config/env-file scanners read the
 * whole argv, including script arguments (v24.14.1 node_config_file.cc:9-31, node_dotenv.cc:19-31).
 */
export const forkExtractor =
  (heapMb: number): Launch =>
  (reportDir) =>
    NodeChildProcess.fork(
      new URL('./main.ts', import.meta.url),
      [],
      processOptions({ heapMb, reportDir }),
    )

/** The two live inputs Node copies into a fork; only the environment string needs tokenization. */
export interface Inherited {
  readonly execArgv: ReadonlyArray<string>
  readonly nodeOptions: Option.Option<string>
}

/** Why the child's old-generation limit can, or cannot, be established before spawning. */
const CapStanding = Schema.TaggedUnion({
  Holds: {},
  PercentageNamed: {},
  OptionsQuoted: {},
  OptionsFromFile: {},
})

/** Includes the negated spelling, which would fail Node startup rather than neutralise a value. */
const PERCENTAGE_FLAG = 'max-old-space-size-percentage'

/** The env-file prefix also covers --env-file-if-exists. Node re-reads these files in the child. */
const FILE_FLAGS = [
  '--experimental-config-file',
  '--experimental-default-config-file',
  '--env-file',
]

/**
 * Establish the old-generation limit without reproducing Node's option parser. Node v24.14.1
 * drops every double quote while tokenizing NODE_OPTIONS (src/node_options.cc:2079-2118), so a
 * quote can hide part of the percentage option's name. Refuse any quoted environment string.
 * Config and env files can supply that option later (node_config_file.cc:9-39, 159-163;
 * node_dotenv.cc:344-350), so refuse their flag names too. The remaining tokens are contiguous
 * substrings; Node's underscore-to-dash normalization is the only name change needed here.
 * Containment can refuse harmless paths, but cannot miss these overriding forms. No inherited
 * loader or security option is removed, and no option text is logged. This establishes V8's old
 * generation limit only; young-generation, external and native memory remain outside it.
 */
const capStanding = ({ execArgv, nodeOptions }: Inherited): typeof CapStanding.Type => {
  const texts = [...execArgv, ...Option.toArray(nodeOptions)].map((text) =>
    text.replaceAll('_', '-'),
  )
  if (Array.some(texts, (text) => text.includes(PERCENTAGE_FLAG)))
    return CapStanding.cases.PercentageNamed.make({})
  if (Option.exists(nodeOptions, (text) => text.includes('"')))
    return CapStanding.cases.OptionsQuoted.make({})
  if (Array.some(FILE_FLAGS, (flag) => Array.some(texts, (text) => text.includes(flag))))
    return CapStanding.cases.OptionsFromFile.make({})
  return CapStanding.cases.Holds.make({})
}

/**
 * The two places a forked child inherits Node options from: `execArgv`, which `processOptions`
 * passes on, and the `NODE_OPTIONS` variable of the environment `fork` copies. This reads the live
 * process, not Effect `Config`, because the live process is what the child inherits.
 */
const inheritedOptions = (): Inherited => ({
  execArgv: NodeProcess.execArgv,
  nodeOptions: Option.fromUndefinedOr(NodeProcess.env['NODE_OPTIONS']),
})

/** Static operator guidance; inherited values and paths never enter the error or its message. */
const REFUSALS = {
  PercentageNamed:
    'Remove --max-old-space-size-percentage from the server command line and NODE_OPTIONS; it replaces the PDF extraction heap limit.',
  OptionsQuoted:
    'Write NODE_OPTIONS without double quotes so inherited PDF extraction options can be established.',
  OptionsFromFile:
    'Start the server without --experimental-config-file, --experimental-default-config-file or --env-file; those files can replace the PDF extraction heap limit.',
}

/**
 * Process configuration fails startup, before a document can consume an ingestion attempt.
 * rc.116 Runtime.defaultTeardown reads errorExitCode; 78 identifies configuration refusal.
 * Only a closed reason and static guidance are carried, never inherited option values or paths.
 */
class ExtractionConfigurationError extends Schema.TaggedError<ExtractionConfigurationError>()(
  'ExtractionConfigurationError',
  { reason: Schema.Literals(['PercentageNamed', 'OptionsQuoted', 'OptionsFromFile']) },
  { title: 'Extraction configuration error' },
) {
  readonly [Runtime.errorExitCode] = 78
  override get message() {
    return REFUSALS[this.reason]
  }
}

/** The case tag itself supplies the reason, keeping the error vocabulary total over refusals. */
const refuse = ({ _tag }: Exclude<typeof CapStanding.Type, { _tag: 'Holds' }>) =>
  Effect.fail(new ExtractionConfigurationError({ reason: _tag }))

/**
 * Startup and process launch share one exhaustive admission rule over the inherited inputs.
 * rc.116 TaggedUnion.match takes one output type; name the common Effect so the successful
 * branch does not infer a `never` error channel and erase the configuration refusals.
 */
const admit = Effect.fn('LibraryExtractionProcess.admit')((inherited: Inherited) =>
  CapStanding.match(capStanding(inherited), {
    Holds: () => Effect.void,
    PercentageNamed: refuse,
    OptionsQuoted: refuse,
    OptionsFromFile: refuse,
  }),
)

/** Read what fork actually inherits when run, before startup acquisition and before each fork. */
export const admission = Effect.suspend(() => admit(inheritedOptions()))

/** A running server's inherited inputs changed after startup; do not fork under that new policy. */
const changed = ({ reason }: ExtractionConfigurationError) =>
  Effect.logError('Library extraction refused: unsupported inherited Node configuration').pipe(
    Effect.annotateLogs({ reason }),
    Effect.andThen(Effect.fail(new ExtractionUnavailable())),
  )

/**
 * Exactly one variant per native report; the schema constructors keep the union closed. `code` is
 * libuv's `WEXITSTATUS` (deps/uv/src/unix/process.c:164-166), always an integer, so the `Int` check
 * in `make` cannot throw inside the native listener.
 */
const endOf = (code: number | null, signal: NodeJS.Signals | null): typeof ProcessEnd.Type => {
  if (signal !== null) return ProcessEnd.cases.Signaled.make({ signal })
  if (code !== null) return ProcessEnd.cases.Exited.make({ code })
  return ProcessEnd.cases.Unreported.make({})
}

/**
 * A `ChildProcess` emits `error` for a failed spawn and for a send on a closed channel
 * (lib/internal/child_process.js:284-292, 753-757). With no listener that is an uncaught exception
 * in the server. The listener is never removed. It keeps no detail: the process end is
 * read from `exit`, and a failed spawn from the missing pid.
 */
const absorb = (): void => undefined

/**
 * The inbox state for one process: the held messages and the reader, if one is attached. `receive`
 * is the native `message` listener. Every function here runs to completion on the event loop, so a
 * native message can never fall between "hand over the held ones" and "deliver directly".
 */
const makeInbox = () => {
  const held: Array<NodeChildProcess.Serializable> = []
  let reader = Option.none<Emit>()
  const receive: Emit = (message) => {
    Option.match(reader, {
      onNone: () => {
        held.push(message)
      },
      onSome: (emit) => emit(message),
    })
  }
  const attach = (emit: Emit): void => {
    for (const message of held.splice(0)) emit(message)
    reader = Option.some(emit)
  }
  const detach = (): void => {
    reader = Option.none()
  }
  return { receive, inbox: { attach, detach } satisfies Inbox }
}

/**
 * Spawn and observe in one synchronous step. Node emits `exit`, `error` and `message` from the
 * event loop or `nextTick`, never inside `fork`, so no event can come before these listeners. The
 * SDK attaches later, from a forked fiber (RpcClient.ts:1290-1343, Worker.ts:187-218); what it
 * would have missed is in `ended` and `inbox`.
 *
 * Two spawn failures, both typed `ExtractionUnavailable`:
 * - `EACCES`, `EAGAIN`, `EMFILE`, `ENFILE`, `ENOENT`: `fork` returns, `pid` stays undefined, and
 *   only `error` follows, never `exit` (child_process.js:399-409, 284-294). Nothing was started, so
 *   nothing is left to stop.
 * - any other errno, or rejected options: `fork` throws (child_process.js:410-421).
 */
const observe = (spawn: () => NodeChildProcess.ChildProcess) =>
  Effect.try({
    try: () => {
      const child = spawn()
      const ended = Deferred.makeUnsafe<typeof ProcessEnd.Type>()
      const { receive, inbox } = makeInbox()
      child.on('error', absorb)
      child.once('exit', (code, signal) => {
        Deferred.doneUnsafe(ended, Effect.succeed(endOf(code, signal)))
      })
      child.on('message', receive)
      return { child, pid: child.pid, ended, inbox }
    },
    catch: () => new ExtractionUnavailable(),
  })

/**
 * Start one extraction process, or refuse.
 *
 * The server entry admits configuration before accepting uploads. This check repeats before a
 * fork to detect runtime mutation of those inputs; no server code writes them. A changed unsupported
 * form logs its reason without option text and fails ExtractionUnavailable without spawning.
 * Persistent runtime mutation would still exhaust per-item retries, so it must not be introduced.
 *
 * Only a pid above 1 is a started process. `stop` signals `-pid`, and for the kernel `-0` is the
 * server's own process group and `-1` is every process it may signal. Node's own code tests
 * `this.pid !== 0` after a spawn (child_process.js:451, 454), and the native source that assigns the
 * pid (src/process_wrap.cc) was not inspected, so 0 is refused here instead of assumed impossible.
 */
export const start = Effect.fn('LibraryExtractionProcess.start')(function* (
  spawn: () => NodeChildProcess.ChildProcess,
) {
  yield* admission.pipe(Effect.catchTag('ExtractionConfigurationError', changed))
  const { child, pid, ended, inbox } = yield* observe(spawn)
  if (pid === undefined || pid <= 1) return yield* new ExtractionUnavailable()
  const running: Running = { child, pid, ended, inbox }
  return running
})

/** `process.kill` reports failure by throwing; only an errno name such as `ESRCH` is kept. */
const Errno = Schema.Struct({ code: Schema.String })
const decodeErrno = Schema.decodeUnknownOption(Errno)

/** The kill was not delivered. This is not a process end: only the `exit` receipt is. */
class SignalRefused extends Schema.TaggedError<SignalRefused>()(
  'SignalRefused',
  { errno: Schema.Option(Schema.String) },
  { title: 'Extraction process signal refused' },
) {}

/**
 * Check and signal in one synchronous block, so no `exit` can be observed between the two.
 *
 * Policy, ported from Effect's own spawner (platform-node-shared rc.116
 * NodeChildProcessSpawner.ts:391-412): signal the process group with the negative pid. Adapted:
 * always `SIGKILL` (one process per PDF, nothing to flush), and no `child.kill` fallback, so there
 * is one mechanism. The target is only the pid this adapter captured at spawn, never a name or a
 * pattern.
 *
 * Nothing is sent once `exit` was observed: the leader is reaped by then and its id may belong to
 * another process. One window remains and is inherent to Node without pidfd: libuv reaps every
 * exited child before it runs any exit callback (deps/uv/src/unix/process.c:101-176), so a kill can
 * be sent after the reap and before this adapter's `exit` event.
 */
const signalGroup = ({ pid, ended }: Running) =>
  Effect.try({
    try: () => {
      if (!Deferred.isDoneUnsafe(ended)) NodeProcess.kill(-pid, 'SIGKILL')
    },
    catch: (cause) =>
      new SignalRefused({
        errno: Option.map(decodeErrno(cause), ({ code }) => code),
      }),
  })

/** A refused kill is logged by errno name only; the thrown value carries nothing else worth keeping. */
const reportRefusal = ({ errno }: SignalRefused) =>
  Option.match(errno, {
    onNone: () => Effect.logWarning('Library extraction process signal refused'),
    onSome: (code) =>
      Effect.logWarning('Library extraction process signal refused').pipe(
        Effect.annotateLogs({ errno: code }),
      ),
  })

/**
 * End the process group if it is still running, then wait for the native `exit` receipt. The kill
 * result is not evidence, so `stop` has no failure type; a refused kill (`ESRCH`: the group is
 * already gone, `EPERM`) is logged and the wait still stands.
 *
 * Uninterruptible: a signal that was sent is always followed by the wait. The wait has no bound. If
 * no `exit` ever follows, `stop` holds its caller; a bounded wait would abandon an owned pid.
 *
 * This is the only termination path. The Worker platform below has no finalizer of its own.
 */
export const stop = Effect.fn('LibraryExtractionProcess.stop')((running: Running) =>
  signalGroup(running).pipe(
    Effect.catchTag('SignalRefused', reportRefusal),
    Effect.andThen(Deferred.await(running.ended)),
    Effect.asVoid,
    Effect.uninterruptible,
  ),
)

/** The SDK's typed worker failure, without a native cause: no child detail enters the error. */
const receiveError = (message: string) =>
  new WorkerError({ reason: new WorkerReceiveError({ message }) })

/**
 * The Worker platform for one already started process, built on the SDK's public extension point
 * `Worker.makePlatform` (effect rc.116 Worker.ts:145-246), the same constructor the official Node,
 * Bun and browser platforms use. Adapted from the official `NodeWorker.layerPlatform`
 * (platform-node rc.116 NodeWorker.ts:31-106); the framing (`[0, message]` out, `[0]` and
 * `[1, data]` in), the request buffer and the readiness latch all stay in the SDK
 * (Worker.ts:163-243). This platform frames nothing and reads no message.
 *
 * Why the official platform is not used for a process: it learns of `exit` and of the ready message
 * from listeners it registers when `setup` and `listen` run (NodeWorker.ts:50-52, 67-104). Those run
 * in a forked fiber after scheduler yields (Worker.ts:187-218), and an `EventEmitter` does not
 * replay. A process that exited, or sent its ready message, before that point is never seen: the
 * run never fails, or the request stays buffered until the deadline calls it `time`. The official
 * finalizer also waits five seconds on the `Clock` for an exit it may have missed
 * (NodeWorker.ts:53-62). Effect main and the current release carry the same source.
 *
 * Changes from the reference, each for that reason:
 * - `W` is `Running`, not a native process: exit and messages come from the state captured at spawn.
 * - `setup` adds no finalizer. There is no close message `[1]`, no five-second timer and no second
 *   kill: `stop` owns termination and the exit receipt.
 * - `listen` reads the end from `ended`. If the process ended before `listen` ran, the run fails at
 *   once with the typed `WorkerError`. The SDK then retries on its schedule (RpcClient.ts:1337); the
 *   Spawner returns the same record, and the run fails the same way without a new process.
 * - no `messageerror` listener: a `ChildProcess` does not emit it.
 * - the native `error` value is not attached to the `WorkerError`.
 *
 * The `error` listener and the inbox reader belong to the run's scope and are removed when it closes.
 */
export const platform = Worker.makePlatform<Running>()({
  setup: ({ worker }) =>
    Effect.succeed({
      postMessage: (message: NodeChildProcess.Serializable) => {
        worker.child.send(message)
      },
      running: worker,
    }),
  listen: ({ port, emit, deferred, scope }) =>
    Effect.gen(function* () {
      const { child, inbox, ended } = port.running
      const onError = () => {
        Deferred.doneUnsafe(deferred, Effect.fail(receiveError('An error event was emitted')))
      }
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          inbox.detach()
          child.off('error', onError)
        }),
      )
      child.on('error', onError)
      inbox.attach(emit)
      yield* Deferred.await(ended).pipe(
        Effect.andThen(Deferred.fail(deferred, receiveError('Extraction process ended'))),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    }),
})

/**
 * The two services `RpcClient.makeProtocolWorker` needs (RpcClient.ts:1254-1272), for one process.
 * Both are plain values, so providing this layer registers no finalizer. The Spawner cannot fail and
 * never starts anything: it returns the process `start` already observed, on every call.
 */
export const layer = (running: Running): Layer.Layer<Worker.WorkerPlatform | Worker.Spawner> =>
  Layer.merge(
    Worker.layerSpawner<Running>(() => running),
    Layer.succeed(Worker.WorkerPlatform)(platform),
  )

/**
 * The three header fields that identify V8 heap exhaustion in one process. Node writes them in
 * `WriteNodeReport` (src/node_report.cc:117-120, 159): `event` is the handler's message and
 * `trigger` is `"OOMError"` only from `OOMErrorHandler`, which picks this message only when V8 set
 * `is_heap_oom` (src/node_errors.cc:594-600, 623). `Struct` ignores every other key by default
 * (effect rc.116 SchemaAST.ts:463), so the rest of the report is dropped at decode.
 */
const HeapReport = Schema.fromJsonString(
  Schema.Struct({
    header: Schema.Struct({
      trigger: Schema.Literal('OOMError'),
      event: Schema.Literal('Allocation failed - JavaScript heap out of memory'),
      processId: Schema.Int,
    }),
  }),
)
const decodeHeapReport = Schema.decodeUnknownOption(HeapReport)

/**
 * True only when the report in `reportDir` says that Node's OOM handler ran for a V8 heap OOM in
 * the process `pid`. Call it after that process ended by `SIGABRT`: Node writes and closes the file
 * before it aborts, on the same thread (node_errors.cc:623-627, node_report.cc:927-929).
 *
 * The report is native ingress and is decoded once. Its text is never logged and never returned.
 *
 * The answer errs one way. A missing, unreadable, oversized, malformed or foreign report is `false`,
 * so a real heap OOM can be reported as no evidence, and no other death can be reported as heap.
 * Every `PlatformError` from the read is therefore the same answer, `false`.
 *
 * Assumption, stated: the file is private to this process pair. The directory is created by the
 * caller per extraction, the path is `dir + separator + name` exactly as Node builds it
 * (node_report.cc:882), and the only writer has ended. A descendant of the child that is still alive
 * could rewrite the file during the read; the production entry starts none.
 */
export const heapEvidence = Effect.fn('LibraryExtractionProcess.heapEvidence')(function* (
  reportDir: string,
  pid: number,
) {
  const fs = yield* FileSystem.FileSystem
  const bytes = fs.stream(`${reportDir}/${REPORT_FILE}`, { bytesToRead: REPORT_READ_BYTES })
  const text = yield* Effect.option(Stream.mkString(Stream.decodeText(bytes)))
  return Option.exists(
    Option.flatMap(text, decodeHeapReport),
    ({ header }) => header.processId === pid,
  )
})
