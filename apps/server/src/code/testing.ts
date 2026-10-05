import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { Cause, Effect, Layer, Queue, Stream } from 'effect'
import { MachineOperationFailed, MachineOutput, type MachineFailure } from '../computers/machine.ts'
import type { ComputerAttachment } from '../computers/store.ts'
import { CodeComputer, loadRunner, openGuest } from './computer.ts'

/**
 * A Computer for tests that is this machine: a fresh directory stands for the Computer's home,
 * the start command runs in it with the local shell and Node, and a file is written into it.
 *
 * It replaces only the provider. The start command, the runner's first installation, the runner
 * itself (`guest.mjs`), the messages and the files that answer them are the ones production uses,
 * so a supervised test run here exercises all of them. What it cannot show is Boat: its stream,
 * its file API and a machine that has to be woken have their own live test.
 */
const localAttachment = (home: string): ComputerAttachment => ({
  follow: ({ command }) =>
    Stream.callback<MachineOutput, MachineFailure>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const child = NodeChildProcess.spawn('/bin/sh', ['-c', command], {
            cwd: home,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (text: string) => {
            Queue.offerUnsafe(queue, MachineOutput.cases.Printed.make({ text }))
          })
          child.on('error', () => {
            // A shell that cannot start is this machine's fault, told as a provider's would be.
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new MachineOperationFailed({ operation: 'local-start' })),
            )
          })
          child.on('close', (exitCode) => {
            Queue.offerUnsafe(
              queue,
              MachineOutput.cases.Exited.make({ exitCode, timedOut: false, memory: false }),
            )
            Queue.endUnsafe(queue)
          })
          return child
        }),
        // The captured child only: the runner ends its own worker, and no pattern is searched.
        (child) => Effect.sync(() => child.kill('SIGKILL')),
      ),
    ),
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

/** Every Person gets the same local home; programs keep apart by their own directories. */
export const localCodeComputerLayer = Layer.effect(
  CodeComputer,
  Effect.gen(function* () {
    const runner = yield* loadRunner
    const home = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-computer-'))),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    )
    const attachment = localAttachment(home)
    return CodeComputer.of({ open: () => openGuest(attachment, runner) })
  }),
)
