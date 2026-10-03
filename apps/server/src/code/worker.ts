import * as NodeProcess from 'node:process'
import {
  CodemodeSandbox,
  type CodemodeResult,
  type CodemodeTool,
} from '@earendil-works/pi-codemode'
// A cold isolated process needs only Code's schemas and Node's runner; barrel imports eagerly
// initialize unrelated product contracts and platform services on every interpreter startup.
import { CodeCallKind, CodeFailure } from '@vivid/contracts/code'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { budgets } from './budgets.ts'
import { finish, guestJson } from './results.ts'
import { FrameReader, writeFrame } from './pipe.ts'
import {
  decodeParent,
  encodeWorker,
  ParentMessage,
  PipeFailure,
  WorkerMessage,
} from './protocol.ts'

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

/** Bounded callback bookkeeping and a permanent quota latch also protect unawaited call storms. */
class Bridge {
  readonly pending = new Map<number, Deferred.Deferred<Schema.Json, PipeFailure>>()
  failure: Option.Option<CodeFailure> = Option.none()
  private next = 0
  private attempts = 0

  private readonly writes: Semaphore.Semaphore

  /** A single writer serializes frames; explicit fields keep the child in Node's erasable subset. */
  constructor(writes: Semaphore.Semaphore) {
    this.writes = writes
  }

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
      : yield* finish(result)
    return yield* writes.withPermit(writeFrame(NodeProcess.stdout, encodeWorker(message), 'result'))
  }),
).pipe(Effect.catchCause(() => Effect.void))

export { program }
