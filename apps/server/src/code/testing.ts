import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { Cause, Deferred, Effect, Layer, Queue, Stream } from 'effect'
import { MachineOperationFailed, type MachineFailure } from '../computers/machine.ts'
import type { ComputerAttachment } from '../computers/store.ts'
import { CodeComputer, installRunner, loadRunner, openGuest } from './computer.ts'

/**
 * A Computer for tests that is this machine: a fresh directory stands for the Computer's home,
 * the start command runs in it with the local shell and Node, and a file is written into it.
 *
 * It replaces only the way to the machine. The start command, the runner's installation, the
 * runner itself (`guest.mjs`) and the messages in both directions are the ones production uses,
 * so a supervised test run here exercises all of them. What it cannot show is Boat: its stream,
 * its file API and a machine that has to be woken have their own live test.
 */
const localAttachment = (home: string): ComputerAttachment => ({
  converse: ({ command }) =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<string, MachineFailure | Cause.Done>()
      const ended = yield* Deferred.make<
        { readonly exitCode: number | null; readonly timedOut: boolean },
        MachineFailure
      >()
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const started = NodeChildProcess.spawn('/bin/sh', ['-c', command], {
            cwd: home,
            stdio: ['pipe', 'pipe', 'ignore'],
          })
          started.stdout.setEncoding('utf8')
          started.stdout.on('data', (text: string) => {
            Queue.offerUnsafe(output, text)
          })
          started.on('error', () => {
            // A shell that cannot start is this machine's fault, told as a provider's would be.
            const failure = new MachineOperationFailed({ operation: 'local-start' })
            Deferred.doneUnsafe(ended, Effect.fail(failure))
            Queue.failCauseUnsafe(output, Cause.fail(failure))
          })
          started.on('close', (exitCode) => {
            Deferred.doneUnsafe(ended, Effect.succeed({ exitCode, timedOut: false }))
            Queue.endUnsafe(output)
          })
          // A runner that has ended closes its input; a late answer must not end this process.
          started.stdin.on('error', () => undefined)
          return started
        }),
        // The captured child only: the runner ends its own worker, and no pattern is searched.
        (started) => Effect.sync(() => started.kill('SIGKILL')),
      )
      return {
        output: Stream.fromQueue(output),
        say: (text: string) =>
          Effect.sync(() => {
            child.stdin.write(text)
          }),
        ended: Deferred.await(ended),
      }
    }),
  write: ({ path, content }) =>
    Effect.try({
      try: () => {
        const target = NodePath.join(home, path)
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true })
        NodeFS.writeFileSync(target, content)
      },
      catch: () => new MachineOperationFailed({ operation: 'local-write' }),
    }),
})

/**
 * Every Person gets the same local home; programs keep apart by their own directories. `alter`
 * lets a test put a fault into the Computer (a write that fails) and nowhere else.
 */
export const localCodeComputer = (alter: (attachment: ComputerAttachment) => ComputerAttachment) =>
  Layer.effect(
    CodeComputer,
    Effect.gen(function* () {
      const runner = yield* loadRunner
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-computer-'))),
        (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
      )
      const attachment = alter(localAttachment(home))
      // The one local home has the runner put on it once, as a Computer has on its first program.
      yield* installRunner(attachment, runner)
      return CodeComputer.of({ open: () => openGuest(attachment, runner, Effect.void) })
    }),
  )

export const localCodeComputerLayer = localCodeComputer((attachment) => attachment)
