import * as NodeWorkerThreads from 'node:worker_threads'
import * as NodeWorker from '@effect/platform-node/NodeWorker'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as Transferable from 'effect/unstable/workers/Transferable'

/** Chosen policy, not a measured pdf.js budget; the deadline includes protocol acquisition. */
export const EXTRACTION_DEADLINE = Duration.seconds(60)
/** Only V8 old-generation heap is capped; typed-array backing stores and native memory are not. */
export const EXTRACTION_HEAP_MB = 512

/** Only pdf.js's InvalidPDFException proves invalid content (unpdf 1.8.1 pdfjs.mjs, wrapReason). */
export class PdfUnreadable extends Schema.TaggedError<PdfUnreadable>()(
  'PdfUnreadable',
  {},
  { title: 'Unreadable PDF' },
) {}

/** pdf.js PasswordException codes 1 and 2 require a password; provider details stay in the thread. */
export class PdfLocked extends Schema.TaggedError<PdfLocked>()(
  'PdfLocked',
  {},
  { title: 'Locked PDF' },
) {}

/** An unpdf rejection outside the two known content names remains retryable, without raw details. */
export class ExtractionFaulted extends Schema.TaggedError<ExtractionFaulted>()(
  'ExtractionFaulted',
  {},
  { title: 'PDF extraction faulted' },
) {}

/** The decision records which bounded resource ended extraction, independently of induced exit. */
export class ExtractionLimitExceeded extends Schema.TaggedError<ExtractionLimitExceeded>()(
  'ExtractionLimitExceeded',
  { limit: Schema.Literals(['time', 'heap']) },
  { title: 'PDF extraction limit exceeded' },
) {}

/** Startup, unexpected death, broken transport, or an unconfirmed stop remains retryable. */
export class ExtractionUnavailable extends Schema.TaggedError<ExtractionUnavailable>()(
  'ExtractionUnavailable',
  {},
  { title: 'PDF extraction unavailable' },
) {}

/** Transferable.ts:197-200 preserves binary data through the RPC JSON codec and transfers its buffer. */
export const ExtractionRpcs = RpcGroup.make(
  Rpc.make('ExtractPdf', {
    payload: { bytes: Transferable.Uint8Array },
    success: Schema.Array(Schema.String),
    error: Schema.Union([PdfUnreadable, PdfLocked, ExtractionFaulted]),
  }),
)

type ThreadEnd = ExtractionLimitExceeded | ExtractionUnavailable
interface Running {
  readonly thread: NodeWorkerThreads.Worker
  readonly ended: Deferred.Deferred<never, ThreadEnd>
}

const HeapExhausted = Schema.Struct({ code: Schema.Literal('ERR_WORKER_OUT_OF_MEMORY') })
const decodeHeapExhausted = Schema.decodeUnknownOption(HeapExhausted)

/** Node v24.14.1 Worker[kOnExit] emits the heap error before exit; decode that native ingress once. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native Worker error ingress is decoded immediately; mismatch intentionally carries no native details.
const endFor = (cause: unknown): ThreadEnd =>
  Option.isSome(decodeHeapExhausted(cause))
    ? new ExtractionLimitExceeded({ limit: 'heap' })
    : new ExtractionUnavailable()

/**
 * Spawn and observe in one synchronous step, before NodeWorker.ts:50-102 registers SDK listeners.
 * Deferred.ts:1649 completes once: the first native reason survives the subsequent exit event.
 */
const start = Effect.fn('LibraryExtraction.start')((spawn: () => NodeWorkerThreads.Worker) =>
  Effect.try({
    try: () => {
      const thread = spawn()
      const ended = Deferred.makeUnsafe<never, ThreadEnd>()
      thread.once('error', (cause) => Deferred.doneUnsafe(ended, Effect.fail(endFor(cause))))
      thread.once('exit', () =>
        Deferred.doneUnsafe(ended, Effect.fail(new ExtractionUnavailable())),
      )
      return { thread, ended }
    },
    catch: () => new ExtractionUnavailable(),
  }),
)

/**
 * Node v24.14.1 Worker.prototype.terminate resolves only after exit, or immediately if exited.
 * Type rejection/throw at this native Promise edge as an unconfirmed stop. JavaScript termination
 * is observed; termination while blocked in native code remains unverified and may hold release.
 */
const stop = Effect.fn('LibraryExtraction.stop')((thread: NodeWorkerThreads.Worker) =>
  Effect.tryPromise({
    try: () => thread.terminate(),
    catch: () => new ExtractionUnavailable(),
  }).pipe(Effect.asVoid),
)

/**
 * Build into the caller's outer Scope. NodeWorker.layer (NodeWorker.ts:119-127) contains only
 * Layer.succeed values, so its local provision owns no finalizer. makeProtocolWorker requires
 * Scope, WorkerPlatform and Spawner (RpcClient.ts:1254-1272); its scope survives the verdict.
 * On SDK failure, the earlier native observer preserves heap/death (RpcClient.ts:1320-1335).
 * Race death too: Worker.ts:234-241 can buffer a request on a thread that died before readiness.
 * timeoutOrElse interrupts and awaits the losing call before returning (internal/effect.ts:
 * 1681-1690, 3806-3833, 3865-3880). Nothing here ends the thread or closes its owning SDK scope.
 */
const verdict = Effect.fn('LibraryExtraction.verdict')(function* (
  { thread, ended }: Running,
  bytes: Uint8Array,
) {
  const protocol = yield* RpcClient.makeProtocolWorker({ size: 1 }).pipe(
    Effect.provide(NodeWorker.layer(() => thread)),
    Effect.catchTag('WorkerError', () => Effect.fail(new ExtractionUnavailable())),
  )
  const client = yield* RpcClient.make(ExtractionRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
  // Transfer only an owned copy: database bytes may share a backing store and must remain readable.
  const answered = client.ExtractPdf({ bytes: new Uint8Array(bytes) }).pipe(
    Effect.catchTag('RpcClientError', () =>
      Deferred.poll(ended).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (end) => end,
            onNone: () => Effect.fail(new ExtractionUnavailable()),
          }),
        ),
      ),
    ),
  )
  return yield* Effect.raceFirst(answered, Deferred.await(ended))
})

/**
 * Decide, stop, close: acquireUseRelease runs typed release after use uninterruptibly
 * (Effect.ts:13186; internal/effect.ts:4346-4358), and scoped closes only after release
 * (internal/effect.ts:4073-4082). After native exit the SDK's close is already satisfied
 * (NodeWorker.ts:50-62); stop-induced death therefore cannot replace a time verdict.
 */
export const extractOn = (spawn: () => NodeWorkerThreads.Worker, deadline: Duration.Duration) =>
  Effect.fn('LibraryExtraction.extract')(function* (bytes: Uint8Array) {
    return yield* Effect.scoped(
      Effect.acquireUseRelease(
        start(spawn),
        (running) =>
          verdict(running, bytes).pipe(
            Effect.timeoutOrElse({
              duration: deadline,
              orElse: () => Effect.fail(new ExtractionLimitExceeded({ limit: 'time' })),
            }),
          ),
        (running) => stop(running.thread),
      ),
    )
  })

/** One fresh thread per PDF; upload size and deadline also bound work, not total process memory. */
const spawnExtractor = () =>
  new NodeWorkerThreads.Worker(new URL('./extraction/main.ts', import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: EXTRACTION_HEAP_MB },
  })

/** Production uses the same public lifecycle exercised by real native fixture threads. */
export const extractPdf = extractOn(spawnExtractor, EXTRACTION_DEADLINE)
