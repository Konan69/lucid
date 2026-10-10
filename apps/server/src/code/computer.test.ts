import { describe, expect, it } from '@effect/vitest'
import { CodeFailure } from '@vivid/contracts/code'
import { Cause, Deferred, Effect, Queue, Ref, Stream } from 'effect'
import { MachineOperationFailed, type MachineFailure } from '../computers/machine.ts'
import type { ComputerAttachment } from '../computers/store.ts'
import { installRunner, openGuest } from './computer.ts'
import { ParentMessage, WorkerMessage } from './protocol.ts'

const runner = { path: '.local/share/vivid/computer/program-test.mjs', text: 'runner text' }

type End = { readonly exitCode: number | null; readonly timedOut: boolean }

/**
 * A Computer whose every answer the test decides: what the runner prints and when, how its
 * process ends, and whether a line can be written to it. It records what was said to the runner
 * and the files written. The order of events on a real Computer is exactly what these cases are
 * about, and no real machine can be made to produce a chosen order. That a real runner speaks
 * this way is the supervised suite's claim (`process.test.ts`), and a real SSH channel's is
 * `computers/ssh/link.test.ts`.
 */
const scripted = Effect.fn('Test.scriptedComputer')(function* (
  say: (text: string) => Effect.Effect<void, MachineFailure>,
) {
  const output = yield* Queue.unbounded<string, MachineFailure | Cause.Done>()
  const ended = yield* Deferred.make<End, MachineFailure>()
  const said = yield* Ref.make<ReadonlyArray<string>>([])
  const written = yield* Ref.make<ReadonlyArray<string>>([])
  const commands = yield* Ref.make<ReadonlyArray<string>>([])
  const attachment: ComputerAttachment = {
    converse: ({ command }) =>
      Ref.update(commands, (all) => all.concat([command])).pipe(
        Effect.as({
          output: Stream.fromQueue(output),
          say: (text: string) =>
            say(text).pipe(Effect.andThen(Ref.update(said, (all) => all.concat([text])))),
          ended: Deferred.await(ended),
        }),
      ),
    write: ({ path }) => Ref.update(written, (all) => all.concat([path])),
  }
  /** The runner's process ends: its output is over and the machine says how. */
  const exit = (end: End) =>
    Deferred.succeed(ended, end).pipe(Effect.andThen(Queue.end(output)), Effect.asVoid)
  return { attachment, output, exit, said, written, commands }
})

const line = (message: WorkerMessage) => `${JSON.stringify(message)}\n`
const done = WorkerMessage.cases.Done.make({ result: 1, logs: [], logsTruncated: false })

describe('A program on a Computer, as the server speaks with it', () => {
  it.effect('reads whole messages from pieces and writes one line for each message it sends', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      const guest = yield* openGuest(computer.attachment, runner, Effect.void)
      yield* guest.send(ParentMessage.cases.Start.make({ code: 'return 1' }))
      const call = line(WorkerMessage.cases.Call.make({ id: 1, kind: 'find_tools', input: {} }))
      // One message in two pieces, then two messages in one piece.
      yield* Queue.offer(computer.output, call.slice(0, 9))
      yield* Queue.offer(computer.output, call.slice(9) + line(done))
      expect(yield* guest.read).toEqual(
        WorkerMessage.cases.Call.make({ id: 1, kind: 'find_tools', input: {} }),
      )
      expect(yield* guest.read).toEqual(done)
      expect(yield* Ref.get(computer.said)).toEqual(['{"_tag":"Start","code":"return 1"}\n'])
    }).pipe(Effect.scoped),
  )

  it.effect('writes no answer to a program that has said its last', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      const guest = yield* openGuest(computer.attachment, runner, Effect.void)
      yield* Queue.offer(computer.output, line(done))
      yield* guest.read
      yield* guest.send(ParentMessage.cases.Reply.make({ id: 1, value: null }))
      expect(yield* Ref.get(computer.said)).toEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect('says an answer could not be delivered when the Computer cannot be written to', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() =>
        Effect.fail(new MachineOperationFailed({ operation: 'say' })),
      )
      const guest = yield* openGuest(computer.attachment, runner, Effect.void)
      const sent = yield* Effect.flip(
        guest.send(ParentMessage.cases.Reply.make({ id: 1, value: 1 })),
      )
      expect(sent).toMatchObject({ reason: 'closed' })
    }).pipe(Effect.scoped),
  )

  it.effect('keeps the program’s own reason when its process then ends', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      const guest = yield* openGuest(computer.attachment, runner, Effect.void)
      const failed = WorkerMessage.cases.Failed.make({
        failure: CodeFailure.cases.OverLimit.make({ limit: 'calls' }),
        logs: [],
        logsTruncated: false,
      })
      yield* Queue.offer(computer.output, line(failed))
      yield* guest.read
      yield* computer.exit({ exitCode: 0, timedOut: false })
      expect(yield* Effect.flip(guest.read)).toMatchObject({ reason: 'closed' })
      expect(yield* guest.stopped).toEqual(CodeFailure.cases.OverLimit.make({ limit: 'calls' }))
    }).pipe(Effect.scoped),
  )

  it.effect('tells a process the machine ended at its deadline from one that was lost', () =>
    Effect.gen(function* () {
      const timed = yield* scripted(() => Effect.void)
      const first = yield* openGuest(timed.attachment, runner, Effect.void)
      yield* timed.exit({ exitCode: null, timedOut: true })
      expect(yield* Effect.flip(first.read)).toMatchObject({ reason: 'closed' })
      expect((yield* first.stopped)._tag).toBe('TimedOut')
      const lost = yield* scripted(() => Effect.void)
      const second = yield* openGuest(lost.attachment, runner, Effect.void)
      yield* lost.exit({ exitCode: 1, timedOut: false })
      expect(yield* Effect.flip(second.read)).toMatchObject({ reason: 'closed' })
      expect(yield* second.stopped).toEqual(CodeFailure.cases.Unavailable.make({}))
    }).pipe(Effect.scoped),
  )

  it.effect('refuses a line that is not a message, and one that is too long', () =>
    Effect.gen(function* () {
      const wrong = yield* scripted(() => Effect.void)
      const first = yield* openGuest(wrong.attachment, runner, Effect.void)
      yield* Queue.offer(wrong.output, 'not a message\n')
      expect(yield* Effect.flip(first.read)).toMatchObject({ reason: 'invalid' })
      const long = yield* scripted(() => Effect.void)
      const second = yield* openGuest(long.attachment, runner, Effect.void)
      yield* Queue.offer(long.output, 'x'.repeat(300_000))
      expect(yield* Effect.flip(second.read)).toMatchObject({ reason: 'size' })
    }).pipe(Effect.scoped),
  )

  it.effect('says so when the Computer no longer holds the runner', () =>
    Effect.gen(function* () {
      const computer = yield* scripted(() => Effect.void)
      const gone = yield* Deferred.make<void>()
      const guest = yield* openGuest(
        computer.attachment,
        runner,
        Deferred.succeed(gone, undefined).pipe(Effect.asVoid),
      )
      // The start command's own exit code for "the runner is not on this Computer".
      yield* computer.exit({ exitCode: 78, timedOut: false })
      yield* Deferred.await(gone)
      expect(yield* Effect.flip(guest.read)).toMatchObject({ reason: 'closed' })
    }).pipe(Effect.scoped),
  )

  it.effect('puts the runner on a Computer that does not have it, and only there', () =>
    Effect.gen(function* () {
      const without = yield* scripted(() => Effect.void)
      yield* without.exit({ exitCode: 1, timedOut: false })
      yield* installRunner(without.attachment, runner)
      expect(yield* Ref.get(without.written)).toEqual([runner.path])
      const has = yield* scripted(() => Effect.void)
      yield* has.exit({ exitCode: 0, timedOut: false })
      yield* installRunner(has.attachment, runner)
      expect(yield* Ref.get(has.written)).toEqual([])
    }),
  )
})
