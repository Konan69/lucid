import * as NodeFS from 'node:fs'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as NodeWorkerThreads from 'node:worker_threads'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect } from 'vitest'
import { it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { extractText } from 'unpdf'
import { AbortException, InvalidPDFException, PasswordException } from 'unpdf/pdfjs'
import {
  EXTRACTION_DEADLINE,
  ExtractionLimitExceeded,
  ExtractionUnavailable,
  ExtractionFaulted,
  PdfLocked,
  PdfUnreadable,
  extractOn,
  extractPdf,
} from './extraction.ts'
import { MAX_LIBRARY_FILE_BYTES } from './ingest.ts'
import { Fixture } from './fixtures/mode.ts'
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

/** Fixture budget only: the post-error flag proves handler entry at 64 MB; policy stays 512 MB. */
const GROW_HEAP_MB = 64
const ATTEMPTS = Array.from({ length: 50 }, (_, attempt) => attempt)

/** Each invocation observes only its own native thread; exit is a receipt, never elapsed time. */
const observed = (input: typeof Fixture.Type) => {
  const exited = Deferred.makeUnsafe<void>()
  const spawned = Deferred.makeUnsafe<NodeWorkerThreads.Worker>()
  const spawn = () => {
    const options = Fixture.match(input, {
      spin: () => ({ workerData: input }),
      grow: ({ heapMb }) => ({
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: heapMb },
      }),
      exit: () => ({ workerData: input }),
      defect: () => ({ workerData: input }),
      faulted: () => ({ workerData: input }),
      absent: () => ({ workerData: input }),
    })
    const thread = new NodeWorkerThreads.Worker(
      new URL('./fixtures/main.ts', import.meta.url),
      options,
    )
    thread.once('exit', () => Deferred.doneUnsafe(exited, Effect.void))
    Deferred.doneUnsafe(spawned, Effect.succeed(thread))
    return thread
  }
  return { spawn, spawned, exited }
}

/**
 * Atomics is a receipt from inside the spin handler. The caller races it with fiber join so
 * early death fails visibly; notify releases a pending native waiter when that branch loses.
 */
const entered = Effect.fn('ExtractionTest.entered')((flag: Int32Array) => {
  const receipt = Atomics.waitAsync(flag, 0, 0)
  if (!receipt.async) return Effect.void
  return Effect.tryPromise({
    try: () => receipt.value,
    catch: () => new ExtractionUnavailable(),
  }).pipe(
    Effect.asVoid,
    Effect.ensuring(
      Effect.sync(() => {
        Atomics.notify(flag, 0)
      }),
    ),
  )
})

/** E3 repeats the exact deadline decision on 50 fresh blocked threads and verifies native exit. */
it.effect.each(ATTEMPTS)(
  'E3 decides time before stopping a spinning thread (attempt %$ of 50)',
  () =>
    Effect.gen(function* () {
      const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
      const owned = observed(Fixture.cases.spin.make({ flag: flag.buffer }))
      const fiber = yield* extractOn(
        owned.spawn,
        EXTRACTION_DEADLINE,
      )(new Uint8Array()).pipe(Effect.forkScoped)
      yield* Effect.raceFirst(entered(flag), Fiber.join(fiber))
      expect(Atomics.load(flag, 0)).toBe(1)
      yield* TestClock.adjust(EXTRACTION_DEADLINE)
      assertFailure(yield* Fiber.await(fiber), new ExtractionLimitExceeded({ limit: 'time' }))
      yield* Deferred.await(owned.exited)
      expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
    }),
)

/** E4 must come from Node's heap error; the TestClock deadline is never moved. */
it.effect('E4 reports heap exhaustion and awaits actual thread exit', () =>
  Effect.gen(function* () {
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const owned = observed(Fixture.cases.grow.make({ flag: flag.buffer, heapMb: GROW_HEAP_MB }))
    const exit = yield* Effect.exit(extractOn(owned.spawn, EXTRACTION_DEADLINE)(new Uint8Array()))
    assertFailure(exit, new ExtractionLimitExceeded({ limit: 'heap' }))
    expect(Atomics.load(flag, 0)).toBe(1)
    yield* Deferred.await(owned.exited)
    expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
  }),
)

/** Cancelling a caller must stop blocked JS and preserve interruption without advancing the deadline. */
it.effect('awaits native thread exit when its caller is interrupted', () =>
  Effect.gen(function* () {
    const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const owned = observed(Fixture.cases.spin.make({ flag: flag.buffer }))
    const fiber = yield* extractOn(
      owned.spawn,
      EXTRACTION_DEADLINE,
    )(new Uint8Array()).pipe(Effect.forkScoped)
    yield* Effect.raceFirst(entered(flag), Fiber.join(fiber))
    expect(Atomics.load(flag, 0)).toBe(1)
    yield* Fiber.interrupt(fiber)
    Exit.match(yield* Fiber.await(fiber), {
      onSuccess: () => expect.unreachable('Interrupted extraction unexpectedly succeeded'),
      onFailure: (cause) => expect(Cause.hasInterruptsOnly(cause)).toBe(true),
    })
    yield* Deferred.await(owned.exited)
    expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
  }),
)

/** E5 exercises process.exit inside an actual native RPC handler, rather than a mocked failure. */
it.effect('E5 reports an unavailable thread that exits during its request', () =>
  Effect.gen(function* () {
    const owned = observed(Fixture.cases.exit.make({}))
    const exit = yield* Effect.exit(extractOn(owned.spawn, EXTRACTION_DEADLINE)(new Uint8Array()))
    assertFailure(exit, new ExtractionUnavailable())
    yield* Deferred.await(owned.exited)
    expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
  }),
)

/** E6 catches death before the SDK handshake without advancing time to disguise buffered work. */
it.effect('E6 reports load-time death without waiting for its deadline', () =>
  Effect.gen(function* () {
    const owned = observed(Fixture.cases.absent.make({}))
    const exit = yield* Effect.exit(extractOn(owned.spawn, EXTRACTION_DEADLINE)(new Uint8Array()))
    assertFailure(exit, new ExtractionUnavailable())
    yield* Deferred.await(owned.exited)
    expect((yield* Deferred.await(owned.spawned)).threadId).toBe(-1)
  }),
)

/** E7 starts the production .ts entry, its native RPC server, and unpdf on a real one-page PDF. */
it.effect('E7 extracts a real PDF through the production entry', () =>
  Effect.gen(function* () {
    const bytes = NodeFS.readFileSync(new URL('./fixtures/readable.pdf', import.meta.url))
    expect(yield* extractPdf(bytes)).toEqual(['Vivid extraction fixture'])
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

/** A cap-sized upload crosses the real binary RPC seam without detaching its caller's backing store. */
it.effect('transfers an upload-sized PDF input while preserving the source bytes', () =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(MAX_LIBRARY_FILE_BYTES)
    bytes.fill(0x78)
    const exit = yield* Effect.exit(extractPdf(bytes))
    assertFailure(exit, new PdfUnreadable())
    expect(bytes.byteLength).toBe(MAX_LIBRARY_FILE_BYTES)
    expect(bytes[0]).toBe(0x78)
    expect(bytes[bytes.length - 1]).toBe(0x78)
  }),
)

/** Compile the shared stdout ingress once; E8 still decodes only after EOF and successful exit. */
const decodePages = Schema.decodeUnknownEffect(Pages)

/**
 * E8 uses the production tsx CLI argument shape without loader overrides. Scope owns its process
 * group; stdout EOF, natural exit 0, then decoded pages prove extraction and resource release.
 */
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
  }).pipe(Effect.provide(NodeServices.layer)),
)
