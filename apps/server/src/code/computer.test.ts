import { describe, expect, it } from '@effect/vitest'
import { CodeFailure } from '@vivid/contracts'
import { CodeTiming } from '@vivid/contracts/code'
import { Deferred, Effect, Fiber, Queue, Ref, Stream, type Cause } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { MachineOperationFailed, MachineOutput, type MachineFailure } from '../computers/machine.ts'
import type { ComputerAttachment } from '../computers/store.ts'
import { openGuest, type Runner } from './computer.ts'
import { encodeWorker, ParentMessage, WorkerMessage } from './protocol.ts'

const runner: Runner = { path: 'runner.mjs', text: 'the runner' }
const done = `${encodeWorker(
  WorkerMessage.cases.Done.make({ result: 1, logs: [], logsTruncated: false }),
)}\n`
const reply = ParentMessage.cases.Reply.make({ id: 1, value: null })
const cancelFile = expect.stringMatching(/\/in\/cancel\.json$/)
const replyFile = expect.stringMatching(/\/in\/reply-1\.json$/)
const started = expect.stringContaining('exec node')
const removal = expect.stringMatching(/^rm -rf -- '\.cache\/vivid\/programs\//)

/**
 * A Computer whose every answer the test decides: what the followed command prints and when, and
 * whether a file can be written and when the write returns. It records the files written and the
 * commands started. The order of events on a real Computer is exactly what these cases are about,
 * and no real machine can be made to produce a chosen order. They prove which orders and removals
 * the server sends; that a real runner obeys them is the supervised and the live suites' claim.
 */
const scripted = Effect.fn('Test.scriptedComputer')(function* (
  write: (path: string, output: Output) => Effect.Effect<unknown, MachineFailure>,
) {
  const output: Output = yield* Queue.unbounded<MachineOutput, MachineFailure | Cause.Done>()
  const written = yield* Ref.make<ReadonlyArray<string>>([])
  const commands = yield* Ref.make<ReadonlyArray<string>>([])
  const followed = yield* Queue.unbounded<string>()
  const removed = yield* Deferred.make<void>()
  const attachment: ComputerAttachment = {
    follow: ({ command }) =>
      Stream.unwrap(
        Ref.update(commands, (all) => all.concat([command])).pipe(
          Effect.andThen(Queue.offer(followed, command)),
          // Only the program's own command prints; a removal says nothing and ends. As with a
          // real provider, word of the exit is the last thing a followed command carries.
          Effect.andThen(
            command.startsWith('rm ')
              ? Deferred.succeed(removed, undefined).pipe(Effect.as(Stream.empty))
              : Effect.succeed(
                  Stream.fromQueue(output).pipe(Stream.takeUntil(MachineOutput.guards.Exited)),
                ),
          ),
        ),
      ),
    write: ({ path }) =>
      write(path, output).pipe(Effect.andThen(Ref.update(written, (all) => all.concat([path])))),
  }
  /** The removal is not waited for by the program's scope, so a case waits for it here. */
  const afterRemoval = Deferred.await(removed).pipe(
    Effect.andThen(Effect.all({ written: Ref.get(written), commands: Ref.get(commands) })),
  )
  /** Waits until one more command has been started on the Computer. */
  const nextStart = Queue.take(followed)
  return { attachment, output, afterRemoval, nextStart }
})
type Output = Queue.Queue<MachineOutput, MachineFailure | Cause.Done>

const exited = MachineOutput.cases.Exited.make({ exitCode: 0, timedOut: false, memory: false })
/** A runner that is there obeys the order to stop: it ends, and the provider says so. */
const obeys = (path: string, output: Output) =>
  path.includes('cancel') ? Queue.offer(output, exited) : Effect.void

/** One program's scope inside the scope that outlives it, as the server composes them. */
const program = <A, E>(
  computer: Effect.Success<ReturnType<typeof scripted>>,
  use: (guest: Effect.Success<ReturnType<typeof openGuest>>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const background = yield* Effect.scope
    return yield* Effect.scoped(
      openGuest(computer.attachment, runner, background).pipe(Effect.flatMap(use)),
    )
  })

describe('The server’s link to a program on a Computer', () => {
  it.effect('tells a program to stop when the stream broke without word of its end', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      yield* program(computer, (guest) =>
        Effect.gen(function* () {
          yield* Queue.fail(computer.output, new MachineOperationFailed({ operation: 'transport' }))
          expect(yield* guest.read.pipe(Effect.flip)).toHaveProperty('reason', 'closed')
        }),
      )
      // A broken stream is not an ended process: the order to stop is still sent.
      expect(yield* computer.afterRemoval).toEqual({
        written: [cancelFile],
        commands: [started, removal],
      })
    }).pipe(Effect.scoped),
  )

  it.effect('sends no order to a program whose exit the provider reported', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      yield* program(computer, (guest) =>
        Effect.gen(function* () {
          yield* Queue.offer(
            computer.output,
            MachineOutput.cases.Exited.make({ exitCode: 137, timedOut: false, memory: true }),
          )
          expect(yield* guest.read.pipe(Effect.flip)).toHaveProperty('reason', 'closed')
          expect(yield* guest.stopped).toEqual(
            CodeFailure.cases.OverLimit.make({ limit: 'memory' }),
          )
        }),
      )
      expect(yield* computer.afterRemoval).toEqual({ written: [], commands: [started, removal] })
    }).pipe(Effect.scoped),
  )

  it.effect(
    'removes the program’s directory even when an answer landed before its final line was read',
    () =>
      Effect.gen(function* () {
        const computer = yield* scripted(() => Effect.void)
        yield* program(computer, (guest) =>
          Effect.gen(function* () {
            // The runner has already removed its directory and printed its last line, which
            // is still on its way; nothing here knows that when the answer is written.
            yield* guest.send(reply)
            yield* Queue.offer(computer.output, MachineOutput.cases.Printed.make({ text: done }))
            expect(yield* guest.read).toHaveProperty('_tag', 'Done')
          }),
        )
        expect(yield* computer.afterRemoval).toEqual({
          written: [replyFile],
          commands: [started, removal],
        })
      }).pipe(Effect.scoped),
  )

  it.effect('writes no answer and sends no order to a program that has said its last', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      yield* program(computer, (guest) =>
        Effect.gen(function* () {
          yield* Queue.offer(computer.output, MachineOutput.cases.Printed.make({ text: done }))
          expect(yield* guest.read).toHaveProperty('_tag', 'Done')
          yield* guest.send(reply)
        }),
      )
      expect(yield* computer.afterRemoval).toEqual({ written: [], commands: [started, removal] })
    }).pipe(Effect.scoped),
  )

  it.effect(
    'gives up a program whose answer cannot be delivered: it is told to stop and not waited on',
    () =>
      Effect.gen(function* () {
        const computer = yield* scripted((path) =>
          path.includes('reply-')
            ? Effect.fail(new MachineOperationFailed({ operation: 'write' }))
            : Effect.void,
        )
        yield* program(computer, (guest) =>
          Effect.gen(function* () {
            expect(yield* guest.send(reply).pipe(Effect.flip)).toHaveProperty('reason', 'closed')
            // The stream is healthy and silent, and this Computer never says the program
            // ended. Word of its end is waited for only as long as the contract allows.
            const stopping = yield* Effect.forkChild(guest.stopped, { startImmediately: true })
            yield* TestClock.adjust(CodeTiming.endMs)
            expect(yield* Fiber.join(stopping)).toEqual(CodeFailure.cases.Unavailable.make({}))
          }),
        )
        expect(yield* computer.afterRemoval).toEqual({
          written: [cancelFile],
          commands: [started, removal],
        })
      }).pipe(Effect.scoped),
  )

  it.effect('sends the order to stop again when the first one did not reach the Computer', () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const computer = yield* scripted((path, output) =>
        path.includes('cancel')
          ? Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.fail(new MachineOperationFailed({ operation: 'write' }))
                  : Queue.offer(output, exited),
              ),
            )
          : Effect.void,
      )
      yield* program(computer, (guest) =>
        // The deadline's own order, which fails on its way. Closing sends it again.
        guest.send(ParentMessage.cases.Cancel.make({})).pipe(
          Effect.flip,
          Effect.map((failure) => expect(failure).toHaveProperty('reason', 'closed')),
        ),
      )
      expect(yield* computer.afterRemoval).toEqual({
        written: [cancelFile],
        commands: [started, removal],
      })
      expect(yield* Ref.get(attempts)).toBe(2)
    }).pipe(Effect.scoped),
  )

  it.effect('installs the runner on a Computer that does not have it, then starts it', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(obeys)
      yield* program(computer, () =>
        Effect.gen(function* () {
          yield* computer.nextStart
          // The start command's own word for "no runner here": nothing ran.
          yield* Queue.offer(
            computer.output,
            MachineOutput.cases.Exited.make({ exitCode: 78, timedOut: false, memory: false }),
          )
          // The second start is the program's. It has not ended, so closing must still tell it
          // to stop: the first start's exit does not count for it.
          yield* computer.nextStart
        }),
      )
      expect(yield* computer.afterRemoval).toEqual({
        written: [runner.path, cancelFile],
        commands: [started, started, removal],
      })
    }).pipe(Effect.scoped),
  )
})
