import * as NodeCrypto from 'node:crypto'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect } from 'vitest'
import { layer as testLayer } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as ChildProcess from 'effect/process/ChildProcess'
import { extractText } from 'unpdf'
import { AbortException, InvalidPDFException, PasswordException } from 'unpdf/pdfjs'
import {
  EXTRACTION_HEAP_MB,
  ExtractionLimitExceeded,
  ExtractionUnavailable,
  ExtractionFaulted,
  PdfLocked,
  PdfUnreadable,
  extractPdf,
} from './extraction.ts'
import { MAX_LIBRARY_FILE_BYTES } from './ingest.ts'
import { type Launch, processOptions } from './extraction/process.ts'
import { Fixture } from './fixtures/mode.ts'
import { CRASH_TIMEOUT_MS } from './fixtures/process/mode.ts'
import { GROW_HEAP_MB, nativeLaunch, extractWith, reportRemoved } from './fixtures/launch.ts'
import { rejectionOf } from './extraction/rejection.ts'
import { Pages } from './fixtures/process/pages.ts'

/** Compare the sole typed failure exactly while allowing Effect.fn's diagnostic stack annotations. */
const assertFailure = (
  exit: Exit.Exit<
    ReadonlyArray<string>,
    PdfUnreadable | PdfLocked | ExtractionFaulted | ExtractionLimitExceeded | ExtractionUnavailable
  >,
  expected:
    | PdfUnreadable
    | PdfLocked
    | ExtractionFaulted
    | ExtractionLimitExceeded
    | ExtractionUnavailable,
) =>
  Exit.match(exit, {
    onSuccess: () => expect.unreachable('Extraction unexpectedly succeeded'),
    onFailure: (cause) => {
      expect(cause.reasons).toHaveLength(1)
      expect(Cause.findError(cause)).toEqual(Result.succeed(expected))
    },
  })

/** The real one-page PDF, read fresh so no test shares a buffer with another. */
const readable = () => NodeFS.readFileSync(new URL('./fixtures/readable.pdf', import.meta.url))

testLayer(NodeFileSystem.layer)((it) => {
  /**
   * E3: the deadline decides `time` while the process still blocks, and only then the process group
   * is killed and its exit awaited. Handler entry is a receipt, never elapsed time.
   *
   * Changed on purpose: on worker threads this case ran 50 times. The stop is now one `SIGKILL` to
   * a process group, delivered by the kernel whatever the JavaScript is doing. Each repetition would
   * start one more process to observe that same single code path, so one case stays.
   */
  it.effect('E3 decides time before it stops a spinning process', () =>
    Effect.gen(function* () {
      const owned = nativeLaunch(Fixture.cases.spin.make({}), EXTRACTION_HEAP_MB)
      const fiber = yield* extractWith(owned.launch)(new Uint8Array()).pipe(Effect.forkScoped)
      expect(yield* Effect.raceFirst(Deferred.await(owned.entered), Fiber.join(fiber))).toBe(true)
      yield* TestClock.adjust('59999 millis')
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(yield* Deferred.isDone(owned.ended)).toBe(false)
      yield* TestClock.adjust('1 millis')
      assertFailure(yield* Fiber.await(fiber), new ExtractionLimitExceeded({ limit: 'time' }))
      expect(yield* Deferred.await(owned.ended)).toEqual({ code: null, signal: 'SIGKILL' })
      expect(yield* reportRemoved(owned)).toBe(true)
    }),
  )

  /** Cancelling a caller must stop blocked JavaScript and stay an interruption; no clock is moved. */
  it.effect('awaits native process exit when its caller is interrupted', () =>
    Effect.gen(function* () {
      const owned = nativeLaunch(Fixture.cases.spin.make({}), EXTRACTION_HEAP_MB)
      const fiber = yield* extractWith(owned.launch)(new Uint8Array()).pipe(Effect.forkScoped)
      expect(yield* Effect.raceFirst(Deferred.await(owned.entered), Fiber.join(fiber))).toBe(true)
      yield* Fiber.interrupt(fiber)
      Exit.match(yield* Fiber.await(fiber), {
        onSuccess: () => expect.unreachable('Interrupted extraction unexpectedly succeeded'),
        onFailure: (cause) => expect(Cause.hasInterruptsOnly(cause)).toBe(true),
      })
      expect(yield* Deferred.await(owned.ended)).toEqual({ code: null, signal: 'SIGKILL' })
      expect(yield* reportRemoved(owned)).toBe(true)
    }),
  )

  /**
   * E4: a real V8 heap death inside the RPC handler is `heap`, from Node's own report and not from
   * the signal. The deadline is never moved. The server process survives: the same test then extracts
   * a real PDF through the production entry.
   */
  it.effect(
    'E4 reports heap exhaustion from native evidence and keeps extracting',
    () =>
      Effect.gen(function* () {
        const owned = nativeLaunch(Fixture.cases.grow.make({}), GROW_HEAP_MB)
        const exit = yield* Effect.exit(extractWith(owned.launch)(new Uint8Array()))
        assertFailure(exit, new ExtractionLimitExceeded({ limit: 'heap' }))
        expect(yield* Deferred.await(owned.entered)).toBe(true)
        expect(yield* Deferred.await(owned.ended)).toEqual({ code: null, signal: 'SIGABRT' })
        expect(yield* reportRemoved(owned)).toBe(true)
        expect(yield* extractPdf(readable())).toEqual(['Vivid extraction fixture'])
      }),
    CRASH_TIMEOUT_MS,
  )

  /**
   * The same signal without heap exhaustion is not `heap`: a bare abort inside the handler is
   * retryable `ExtractionUnavailable`. The abort ended only that process; the next extraction runs.
   */
  it.effect(
    'reports an aborted process as unavailable and keeps extracting',
    () =>
      Effect.gen(function* () {
        const owned = nativeLaunch(Fixture.cases.abort.make({}), EXTRACTION_HEAP_MB)
        const exit = yield* Effect.exit(extractWith(owned.launch)(new Uint8Array()))
        assertFailure(exit, new ExtractionUnavailable())
        expect(yield* Deferred.await(owned.entered)).toBe(true)
        expect(yield* Deferred.await(owned.ended)).toEqual({ code: null, signal: 'SIGABRT' })
        expect(yield* reportRemoved(owned)).toBe(true)
        expect(yield* extractPdf(readable())).toEqual(['Vivid extraction fixture'])
      }),
    CRASH_TIMEOUT_MS,
  )

  /** E5 exercises process.exit inside an actual native RPC handler, rather than a mocked failure. */
  it.effect('E5 reports an unavailable process that exits during its request', () =>
    Effect.gen(function* () {
      const owned = nativeLaunch(Fixture.cases.exit.make({}), EXTRACTION_HEAP_MB)
      const exit = yield* Effect.exit(extractWith(owned.launch)(new Uint8Array()))
      assertFailure(exit, new ExtractionUnavailable())
      expect(yield* Deferred.await(owned.entered)).toBe(true)
      expect(yield* Deferred.await(owned.ended)).toEqual({ code: 1, signal: null })
    }),
  )

  /**
   * E6: the process dies while loading, before the worker handshake, so its request can only sit in
   * the SDK buffer. The verdict comes from the native end; the deadline is never moved.
   */
  it.effect('E6 reports load-time death without waiting for its deadline', () =>
    Effect.gen(function* () {
      const owned = nativeLaunch(Fixture.cases.absent.make({}), EXTRACTION_HEAP_MB)
      const exit = yield* Effect.exit(extractWith(owned.launch)(new Uint8Array()))
      assertFailure(exit, new ExtractionUnavailable())
      expect(yield* Deferred.await(owned.entered)).toBe(false)
      expect(yield* Deferred.await(owned.ended)).toEqual({ code: 1, signal: null })
    }),
  )

  /**
   * A process that cannot be started at all: the executable does not exist, so Node reports the
   * failed spawn by an `error` event and no pid. The lifecycle answers with the typed failure, and
   * the absorbed `error` event does not reach this test process as an uncaught exception.
   */
  it.effect('reports a process that could not be started as unavailable', () =>
    Effect.gen(function* () {
      const launch: Launch = (reportDir) =>
        NodeChildProcess.fork(new URL('./fixtures/main.ts', import.meta.url), [], {
          ...processOptions({ heapMb: EXTRACTION_HEAP_MB, reportDir }),
          execPath: NodeURL.fileURLToPath(new URL('./fixtures/absent-executable', import.meta.url)),
        })
      const exit = yield* Effect.exit(extractWith(launch)(new Uint8Array()))
      assertFailure(exit, new ExtractionUnavailable())
    }),
  )

  /** E7 starts the production .ts entry as a process, its native RPC server, and unpdf on a real PDF. */
  it.effect('E7 extracts a real PDF through the production entry', () =>
    Effect.gen(function* () {
      expect(yield* extractPdf(readable())).toEqual(['Vivid extraction fixture'])
    }),
  )

  /** E7 separates a content rejection returned by pdf.js from infrastructure death. */
  it.effect('E7 reports unreadable bytes through the production entry', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(extractPdf(new TextEncoder().encode('Not a PDF')))
      assertFailure(exit, new PdfUnreadable())
    }),
  )

  const decodePasswordRequest = Schema.decodeUnknownSync(
    Schema.Struct({ name: Schema.Literal('PasswordException'), code: Schema.Literal(1) }),
  )

  /**
   * X1: the hand-written trailer adds Standard security V1/R2, 32-byte O/U, P and ID to readable.pdf.
   * Its entries reject the empty password before a stream is read (unpdf pdfjs.mjs CipherTransformFactory).
   * Direct unpdf ingress proves code 1; the production native RPC must preserve exactly PdfLocked.
   */
  it.effect('X1 returns PdfLocked for a real password request through the native extractor', () =>
    Effect.gen(function* () {
      const bytes = NodeFS.readFileSync(new URL('./fixtures/locked.pdf', import.meta.url))
      const native = yield* Effect.tryPromise({
        try: () => extractText(new Uint8Array(bytes), { mergePages: false }),
        catch: decodePasswordRequest,
      }).pipe(Effect.flip)
      expect(native).toEqual({ name: 'PasswordException', code: 1 })
      assertFailure(yield* Effect.exit(extractPdf(bytes)), new PdfLocked())
    }),
  )

  /** X3: real BaseException subclasses own name/code; unsupported password codes are not content. */
  it.effect.each([
    new PasswordException('fixture', 3),
    new AbortException('fixture'),
    new Error('InvalidPDFException PasswordException'),
  ])('X3 retries unrecognized parser rejection %$', (cause) =>
    Effect.sync(() => expect(rejectionOf(cause)).toEqual(new ExtractionFaulted())),
  )

  /** Known content follows pdf.js own names/codes, not message strings (pdfjs.mjs wrapReason). */
  it.effect.each([
    { cause: new InvalidPDFException('fixture'), expected: new PdfUnreadable() },
    { cause: new PasswordException('fixture', 1), expected: new PdfLocked() },
    { cause: new PasswordException('fixture', 2), expected: new PdfLocked() },
  ])('classifies known pdf.js content rejection %$', ({ cause, expected }) =>
    Effect.sync(() => expect(rejectionOf(cause)).toEqual(expected)),
  )

  /**
   * A cap-sized upload crosses the real binary RPC seam over process IPC, where Node serializes the
   * bytes in chunks, and the caller's own bytes stay intact.
   */
  it.effect(
    'transfers every upload-sized input byte through native RPC without altering its source',
    () =>
      Effect.gen(function* () {
        const bytes = new Uint8Array(MAX_LIBRARY_FILE_BYTES)
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
        const expected = NodeCrypto.createHash('sha256').update(bytes).digest('hex')
        const owned = nativeLaunch(Fixture.cases.digest.make({}), EXTRACTION_HEAP_MB)
        expect(yield* extractWith(owned.launch)(bytes)).toEqual([expected])
        expect(NodeCrypto.createHash('sha256').update(bytes).digest('hex')).toBe(expected)
        expect(yield* reportRemoved(owned)).toBe(true)
      }),
  )

  /** Compile the shared stdout ingress once; E8 still decodes only after EOF and successful exit. */
})

const decodePages = Schema.decodeUnknownEffect(Pages)

/**
 * E8 uses the production tsx CLI argument shape without loader overrides, so the extraction process
 * it forks inherits the loader from `execArgv`. Scope owns the CLI's process group; stdout EOF,
 * natural exit 0, then decoded pages prove extraction and that no process or handle was left.
 */
testLayer(NodeServices.layer)((it) => {
  it.effect('E8 extracts a real PDF when started by the production tsx command', () =>
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(
        NodeProcess.execPath,
        [
          NodeURL.fileURLToPath(import.meta.resolve('tsx/cli')),
          'src/library/fixtures/process/main.ts',
        ],
        {
          cwd: NodeURL.fileURLToPath(new URL('../../', import.meta.url)),
          stdin: 'ignore',
          stderr: 'inherit',
          forceKillAfter: '1 second',
        },
      )
      const printed = yield* Stream.mkString(Stream.decodeText(handle.stdout))
      expect(yield* handle.exitCode, printed).toBe(0)
      expect(yield* decodePages(printed)).toEqual(['Vivid extraction fixture'])
    }),
  )
})
