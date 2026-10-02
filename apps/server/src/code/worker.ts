import * as NodeProcess from 'node:process'
import {
  CodemodeSandbox,
  type CodemodeResult,
  type CodemodeTool,
} from '@earendil-works/pi-codemode'
// A cold isolated process needs only Code's schemas and Node's runner; barrel imports eagerly
// initialize unrelated product contracts and platform services on every interpreter startup.
import { CodeCallKind, CodeFailure } from '@vivid/contracts/code'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { boundedNesting, budgets, bytes } from './budgets.ts'
import { FrameReader, writeFrame } from './pipe.ts'
import {
  decodeParent,
  encodeWorker,
  ParentMessage,
  PipeFailure,
  WorkerMessage,
} from './protocol.ts'

const decodeGuestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** The only Promise adapter is pi's public callback API; tools themselves never run in this child. */
function invokeTool(call: Effect.Effect<Schema.Json, PipeFailure>, signal: AbortSignal) {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- pi's public Promise-only callback ingress in this isolated executable.
  return Effect.runPromise(call, { signal })
}

/** Pi returns failures as values. Rejections outside its VM are installation failures, never host text. */
const execute = Effect.fn('Code.executeGuest')((sandbox: CodemodeSandbox, code: string) =>
  Effect.callback<CodemodeResult, PipeFailure>((resume, signal) => {
    sandbox.execute(code, { signal, store: {} }).then(
      (result) => resume(Effect.succeed(result)),
      () => resume(Effect.fail(new PipeFailure({ reason: 'closed' }))),
    )
  }),
)

/** Serialize and check size/depth before recursive decoding. This is the pi SDK's unknown ingress. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public third-party SDK input is unknown; decoded once here.
const guestJson = Effect.fn('Code.guestJson')(function* (input: unknown, maximum: number) {
  const text = yield* Effect.try({
    try: () => JSON.stringify(input),
    catch: () => new PipeFailure({ reason: 'size' }),
  })
  if (text === undefined) return yield* Effect.fail(new PipeFailure({ reason: 'invalid' }))
  if (bytes(text) > maximum || !boundedNesting(text))
    return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
  return yield* decodeGuestJson(text).pipe(
    Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
  )
})

/** Only JSON returns or text prints are supported; persistent store writes and images are discarded. */
const finish = Effect.fn('Code.finishGuest')(function* (result: CodemodeResult) {
  if (!result.ok) {
    if (result.error.kind === 'sandbox' || result.error.kind === 'aborted')
      return WorkerMessage.cases.Failed.make({ failure: CodeFailure.cases.Unavailable.make({}) })
    if (/out of memory/i.test(result.error.message))
      return WorkerMessage.cases.Failed.make({
        failure: CodeFailure.cases.OverLimit.make({ limit: 'memory' }),
      })
    const failure =
      result.error.kind === 'timeout'
        ? CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })
        : CodeFailure.cases.Threw.make({ message: result.error.message.slice(0, 500) })
    return WorkerMessage.cases.Failed.make({ failure })
  }
  if (result.output.some((item) => item.type === 'image'))
    return WorkerMessage.cases.Failed.make({
      failure: CodeFailure.cases.Threw.make({
        message: 'Programs return JSON or text, not images.',
      }),
    })
  const value =
    result.value === undefined
      ? result.output
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n')
      : result.value
  const json = yield* guestJson(value, budgets.result)
  const message = WorkerMessage.cases.Done.make({ result: json })
  if (bytes(encodeWorker(message)) > budgets.result)
    return WorkerMessage.cases.Failed.make({
      failure: CodeFailure.cases.OverLimit.make({ limit: 'result' }),
    })
  return message
})

/** Bounded callback bookkeeping and a permanent quota latch also protect unawaited call storms. */
class Bridge {
  readonly pending = new Map<number, Deferred.Deferred<Schema.Json, PipeFailure>>()
  failure: Option.Option<CodeFailure> = Option.none()
  private next = 0
  private attempts = 0

  constructor(private readonly writes: Semaphore.Semaphore) {}

  /** A quota failure is a host latch, even if guest code catches the rejected Promise. */
  readonly call = Effect.fn('Code.guestCall')(function* (
    this: Bridge,
    kind: typeof CodeCallKind.Type,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The public pi callback ingress is size-checked and decoded immediately below.
    input: unknown,
  ) {
    if (Option.isSome(this.failure)) return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
    if (++this.attempts > budgets.calls) {
      this.failure = Option.some(CodeFailure.cases.OverLimit.make({ limit: 'calls' }))
      return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
    }
    const value = yield* guestJson(input, budgets.frame).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() => {
          if (failure.reason === 'size')
            this.failure = Option.some(CodeFailure.cases.OverLimit.make({ limit: 'data' }))
        }),
      ),
    )
    const id = ++this.next
    const reply = yield* Deferred.make<Schema.Json, PipeFailure>()
    this.pending.set(id, reply)
    const writes = this.writes
    return yield* Effect.gen(function* () {
      yield* writes.withPermit(
        writeFrame(
          NodeProcess.stdout,
          encodeWorker(WorkerMessage.cases.Call.make({ id, kind, input: value })),
          'call',
        ),
      )
      return yield* Deferred.await(reply)
    }).pipe(Effect.ensuring(Effect.sync(() => this.pending.delete(id))))
  })

  /** Preserve the callback's receiver; the SDK receives only this function, not Effect services. */
  tool(kind: typeof CodeCallKind.Type): CodemodeTool {
    return {
      name: kind,
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- pi's callback ingress is decoded immediately by Bridge.call.
      execute: (input, { signal }) => invokeTool(this.call(kind, input), signal),
    }
  }

  /** Only replies to admitted callbacks are accepted; a spoofed correlation ends the child. */
  readonly receive = Effect.fn('Code.guestReply')(function* (this: Bridge, reader: FrameReader) {
    const reply = yield* reader
      .read()
      .pipe(Effect.flatMap((text) => decodeParent(text, { onExcessProperty: 'error' })))
    if (!ParentMessage.guards.Reply(reply))
      return yield* Effect.fail(new PipeFailure({ reason: 'invalid' }))
    const waiting = this.pending.get(reply.id)
    if (waiting === undefined) return yield* Effect.fail(new PipeFailure({ reason: 'invalid' }))
    return yield* Deferred.succeed(waiting, reply.value)
  })
}

/** Closing pi is a Promise-only lifecycle adapter, hidden inside this executable entry. */
const close = Effect.fn('Code.closeGuest')((sandbox: CodemodeSandbox) =>
  Effect.callback<void>((resume) => {
    sandbox.close().then(
      () => resume(Effect.void),
      () => resume(Effect.void),
    )
  }),
)

/** The process owns one fresh VM and exits after it. There is no identity, credential or network API. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const reader = new FrameReader(NodeProcess.stdin)
    const first = yield* reader
      .read()
      .pipe(Effect.flatMap((text) => decodeParent(text, { onExcessProperty: 'error' })))
    if (!ParentMessage.guards.Start(first))
      return yield* Effect.fail(new PipeFailure({ reason: 'invalid' }))
    const writes = yield* Semaphore.make(1)
    const bridge = new Bridge(writes)
    const tools = CodeCallKind.literals.map((kind) => bridge.tool(kind))
    const sandbox = new CodemodeSandbox({
      tools,
      memoryLimitBytes: budgets.heap,
      timeoutMs: budgets.seconds * 1000,
    })
    yield* Effect.addFinalizer(() => close(sandbox))
    // Pipe EOF, including parent death, interrupts pi even when synchronous guest code spins.
    const result = yield* Effect.raceFirst(
      execute(sandbox, first.code),
      Effect.forever(bridge.receive(reader)),
    )
    const message = Option.isSome(bridge.failure)
      ? WorkerMessage.cases.Failed.make({ failure: bridge.failure.value })
      : yield* finish(result).pipe(
          Effect.catchTag('CodePipeFailure', () =>
            Effect.succeed(
              WorkerMessage.cases.Failed.make({
                failure: CodeFailure.cases.OverLimit.make({ limit: 'result' }),
              }),
            ),
          ),
        )
    return yield* writes.withPermit(writeFrame(NodeProcess.stdout, encodeWorker(message), 'result'))
  }),
).pipe(Effect.catchCause(() => Effect.void))

// oxlint-disable-next-line vivid/no-platform-runtime-runmain-in-library -- This file is an executable isolated child entry point, never imported by the server.
NodeRuntime.runMain(program, { disableErrorReporting: true })
