import { describe, expect, it } from '@effect/vitest'
import { CodeFailure } from '@vivid/contracts'
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

/**
 * A Computer whose every answer the test decides: what the followed command prints and when, and
 * whether a file can be written and when the write returns. It records the files written and the
 * commands started. The order of events on a real Computer is exactly what these cases are about,
 * and no real machine can be made to produce a chosen order.
 */
const scripted = Effect.fn('Test.scriptedComputer')(function* (
  write: (path: string) => Effect.Effect<void, MachineFailure>,
) {
  const output = yield* Queue.unbounded<MachineOutput, MachineFailure | Cause.Done>()
  const written = yield* Ref.make<ReadonlyArray<string>>([])
  const commands = yield* Ref.make<ReadonlyArray<string>>([])
  const attachment: ComputerAttachment = {
    follow: ({ command }) =>
      Stream.unwrap(
        Ref.update(commands, (all) => all.concat([command])).pipe(
          // Only the program's own command prints; a removal says nothing and ends. As with a
          // real provider, word of the exit is the last thing a followed command carries.
          Effect.as(
            command.startsWith('rm ')
              ? Stream.empty
              : Stream.fromQueue(output).pipe(Stream.takeUntil(MachineOutput.guards.Exited)),
          ),
        ),
      ),
    write: ({ path }) =>
      write(path).pipe(Effect.andThen(Ref.update(written, (all) => all.concat([path])))),
  }
  return { attachment, output, written: Ref.get(written), commands: Ref.get(commands) }
})

const reply = ParentMessage.cases.Reply.make({ id: 1, value: null })

describe('The server’s link to a program on a Computer', () => {
  it.effect(
    'tells a program to stop when the stream broke without word of its end, and takes its directory away',
    () =>
      Effect.gen(function* () {
        const computer = yield* scripted(() => Effect.void)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const guest = yield* openGuest(computer.attachment, runner)
            yield* Queue.fail(
              computer.output,
              new MachineOperationFailed({ operation: 'transport' }),
            )
            expect(yield* guest.read.pipe(Effect.flip)).toHaveProperty('reason', 'closed')
          }),
        )
        // A broken stream is not an ended process: the order to stop is still sent. Nobody may be
        // reading it, so the directory its file put back is removed.
        expect(yield* computer.written).toEqual([expect.stringMatching(/\/in\/cancel\.json$/)])
        expect(yield* computer.commands).toEqual([
          expect.stringContaining('exec node'),
          expect.stringMatching(/^rm -rf -- '\.cache\/vivid\/programs\//),
        ])
      }),
  )

  it.effect('sends no order to a program whose exit the provider reported', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const guest = yield* openGuest(computer.attachment, runner)
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
      expect(yield* computer.written).toEqual([])
      expect(yield* computer.commands).toHaveLength(1)
    }),
  )

  it.effect(
    'removes the directory an answer put back when it arrived after the program had finished',
    () =>
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>()
        const computer = yield* scripted(() => Deferred.await(held))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const guest = yield* openGuest(computer.attachment, runner)
            // The answer is on its way to the Computer when the program prints its last line.
            const answering = yield* Effect.forkChild(guest.send(reply), { startImmediately: true })
            yield* Queue.offer(computer.output, MachineOutput.cases.Printed.make({ text: done }))
            expect(yield* guest.read).toHaveProperty('_tag', 'Done')
            yield* Deferred.succeed(held, undefined)
            yield* Fiber.join(answering)
          }),
        )
        expect(yield* computer.written).toEqual([expect.stringMatching(/\/in\/reply-1\.json$/)])
        expect(yield* computer.commands).toEqual([
          expect.stringContaining('exec node'),
          expect.stringMatching(/^rm -rf -- '\.cache\/vivid\/programs\//),
        ])
      }),
  )

  it.effect('writes no answer for a program that has already said its last', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const guest = yield* openGuest(computer.attachment, runner)
          yield* Queue.offer(computer.output, MachineOutput.cases.Printed.make({ text: done }))
          expect(yield* guest.read).toHaveProperty('_tag', 'Done')
          yield* guest.send(reply)
        }),
      )
      expect(yield* computer.written).toEqual([])
      expect(yield* computer.commands).toHaveLength(1)
    }),
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
        yield* Effect.scoped(
          Effect.gen(function* () {
            const guest = yield* openGuest(computer.attachment, runner)
            expect(yield* guest.send(reply).pipe(Effect.flip)).toHaveProperty('reason', 'closed')
            // The stream is healthy and silent: the program is waiting for the answer that
            // never came. Its end is waited for only briefly.
            const stopping = yield* Effect.forkChild(guest.stopped, { startImmediately: true })
            yield* TestClock.adjust('5 seconds')
            expect(yield* Fiber.join(stopping)).toEqual(CodeFailure.cases.Unavailable.make({}))
          }),
        )
        expect(yield* computer.written).toEqual([expect.stringMatching(/\/in\/cancel\.json$/)])
      }),
  )

  it.effect('installs the runner on a Computer that does not have it, then starts it', () =>
    Effect.gen(function* () {
      const placed = yield* Deferred.make<void>()
      const computer = yield* scripted((path) =>
        path === runner.path ? Deferred.succeed(placed, undefined) : Effect.void,
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const guest = yield* openGuest(computer.attachment, runner)
          // The start command's own word for "no runner here": nothing ran.
          yield* Queue.offer(
            computer.output,
            MachineOutput.cases.Exited.make({ exitCode: 78, timedOut: false, memory: false }),
          )
          // The second start prints only once the runner has been put there.
          yield* Deferred.await(placed)
          yield* Queue.offer(computer.output, MachineOutput.cases.Printed.make({ text: done }))
          expect(yield* guest.read).toHaveProperty('_tag', 'Done')
        }),
      )
      expect(yield* computer.written).toEqual(['runner.mjs'])
      expect(yield* computer.commands).toHaveLength(2)
    }),
  )
})
