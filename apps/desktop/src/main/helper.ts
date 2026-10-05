import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import {
  Framed,
  HelperLine,
  HelperReply,
  LINE_LIMIT_BYTES,
  budgetCeiling,
  decodeLine,
  lineFramer,
  requestLine,
  type HelperCall,
} from './wire.ts'

/**
 * Vivid's Windows helper as a supervised child process.
 *
 * What the helper's README asks of the desktop app ("What the desktop app must do") and where it
 * is done here:
 * - one process, `--parent-pid <main pid>`, `windowsHide`, private piped stdio that never reaches
 *   a renderer (`spawnHelper`);
 * - BOTH stdout and stderr drained for as long as the process lives, stderr into a bounded ring
 *   whose content is never logged (its lines are the helper's own short diagnostics, but nothing
 *   from another program is worth trusting into a log);
 * - one request at a time, each with its turn and its budget (`ask`, under a semaphore);
 * - a desktop watchdog of its own: a request that outlives its budget by `WATCHDOG_GRACE_MS`, a
 *   line that is not this protocol, or a line over the cap ends the process, and only the process
 *   this module spawned;
 * - exit for any reason (70 included) ends the request in flight as `Lost`, never as an answer.
 *
 * The process belongs to a scope: closing it kills the helper and waits for it to be gone.
 */

/** The executable's name, as `build.ps1` writes it and the README's spawn line names it. */
export const HELPER_EXECUTABLE = 'Vivid.Windows.exe'

/**
 * How long past its own budget a request may run before the desktop stops waiting. The helper
 * exits 70 by itself when a request overruns; this is for a helper that does neither.
 */
export const WATCHDOG_GRACE_MS = 2_000

/** How much of the helper's stderr is kept: its newest bytes, and no more. */
const DIAGNOSTIC_RING_BYTES = 16 * 1024

/** How to start the helper: the program and its arguments. A test names a stand-in here. */
export interface HelperCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * Where the helper is on this computer, when it is anywhere.
 *
 * Windows only. Packaged, it is the file `electron-builder.yml` ships under the resources
 * directory; in development it is what `build.ps1` wrote into the desktop app's own `dist`
 * (`scripts/build.mjs` runs it on Windows). Anywhere else, and wherever the file is absent, there
 * is no helper: nothing is spawned and this computer says it cannot do apps.
 */
export const locateHelper = (input: {
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  readonly resources: string
  /** The directory of the running main bundle (`dist/main`). */
  readonly bundle: string
  readonly parent: number
}): Option.Option<HelperCommand> => {
  if (input.platform !== 'win32') return Option.none()
  const path = input.packaged
    ? NodePath.join(input.resources, 'native', 'windows', HELPER_EXECUTABLE)
    : NodePath.resolve(input.bundle, '../native/windows', HELPER_EXECUTABLE)
  return NodeFS.existsSync(path)
    ? Option.some({ command: path, args: ['--parent-pid', String(input.parent)] })
    : Option.none()
}

/** The helper could not be started at all. Nothing ran. */
export class HelperUnavailable extends Schema.TaggedError<HelperUnavailable>()(
  'HelperUnavailable',
  {},
  { title: 'Vivid’s helper could not be started' },
) {}

export interface Helper {
  /**
   * Sends one request and waits for its reply. Requests are strictly one at a time. `budget` is
   * the milliseconds this request may take; it is cut to the helper's own ceiling for the method.
   */
  readonly ask: (input: {
    readonly call: HelperCall
    readonly turn: Option.Option<string>
    readonly budget: number
  }) => Effect.Effect<HelperReply>
}

export interface HelperListeners {
  /** The helper's `stopped` line: the Person pressed Escape during this turn. */
  readonly stopped: (event: { readonly turn: string; readonly cooldown: number }) => void
  /** The process is gone, for any reason. Said once. */
  readonly gone: () => void
}

/** The request waiting for its reply. There is at most one. */
interface Waiting {
  readonly id: number
  readonly reply: Deferred.Deferred<HelperReply>
}

/**
 * Starts the process and returns the wires to it. The narrow unsafe part of this module: Node's
 * `spawn` and its event emitters. The release step kills the process this call spawned (never one
 * found by name) and waits until Node reports it gone, so a closed scope leaves nothing running.
 */
const spawnHelper = Effect.fn('DesktopHelper.spawn')(function* (command: HelperCommand) {
  const ended = yield* Deferred.make<void>()
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        NodeChildProcess.spawn(command.command, [...command.args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }),
      catch: () => new HelperUnavailable({}),
    }),
    (spawned) =>
      Effect.sync(() => spawned.kill()).pipe(Effect.andThen(Deferred.await(ended)), Effect.asVoid),
  )
  // `error` is how Node reports a program that could not be started; `close` follows an exit
  // once both output pipes have drained. Either means there is no process to talk to.
  const finish = (): void => {
    Deferred.doneUnsafe(ended, Effect.void)
  }
  child.once('error', finish)
  child.once('close', finish)
  // A write to a process that is going away fails on the pipe; the exit that follows is what
  // ends the request, so the pipe's own error needs no second handling.
  child.stdin.on('error', () => undefined)
  return { child, ended }
})

/**
 * Starts the helper in the current scope.
 *
 * Replies are matched to requests by id. A reply whose id is not the one waiting belongs to a
 * request this app stopped waiting for (the Person pressed Stop while it ran) and is dropped.
 */
export const startHelper = Effect.fn('DesktopHelper.start')(function* (
  command: HelperCommand,
  listeners: HelperListeners,
) {
  const { child, ended } = yield* spawnHelper(command)
  const serial = yield* Semaphore.make(1)
  const frame = lineFramer(LINE_LIMIT_BYTES)
  let waiting = Option.none<Waiting>()
  let gone = false
  let next = 1
  let diagnostics = Buffer.alloc(0)

  const lose = (): void => {
    Option.map(waiting, (current) =>
      Deferred.doneUnsafe(
        current.reply,
        Effect.succeed(HelperReply.cases.Lost.make({ sent: true })),
      ),
    )
    waiting = Option.none()
  }
  const forget = (id: number): void => {
    waiting = Option.filter(waiting, (current) => current.id !== id)
  }
  /** The stream is no longer this protocol: stop reading it and end the process. */
  const distrust = (): void => {
    lose()
    child.kill()
  }
  const heard = (line: HelperLine): void =>
    HelperLine.match(line, {
      Stopped: ({ turn, cooldown }) => listeners.stopped({ turn, cooldown }),
      Reply: ({ id, reply }) => {
        const current = Option.filter(waiting, (candidate) => candidate.id === id)
        if (Option.isNone(current)) return
        waiting = Option.none()
        Deferred.doneUnsafe(current.value.reply, Effect.succeed(reply))
      },
    })
  child.stdout.on('data', (chunk: Buffer) => {
    for (const framed of frame(chunk))
      Framed.match(framed, {
        TooLong: distrust,
        Line: ({ text }) => Option.match(decodeLine(text), { onNone: distrust, onSome: heard }),
      })
  })
  // Drained so a full pipe can never block the helper; kept bounded; read by nobody but a
  // developer with a debugger. Not logged: see the module comment.
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = Buffer.concat([diagnostics, chunk]).subarray(-DIAGNOSTIC_RING_BYTES)
  })
  yield* Effect.forkScoped(
    Deferred.await(ended).pipe(
      Effect.andThen(
        Effect.sync(() => {
          gone = true
          lose()
          // The exit code and how much it said, never what it said.
          console.info(
            `desktop: Vivid's helper ended (code ${String(child.exitCode)}, ${diagnostics.length} bytes of diagnostics)`,
          )
          listeners.gone()
        }),
      ),
    ),
  )

  const ask: Helper['ask'] = Effect.fn('DesktopHelper.ask')(function* (input) {
    if (gone) return HelperReply.cases.Lost.make({ sent: false })
    const id = next
    next += 1
    const budget = Math.max(0, Math.min(Math.floor(input.budget), budgetCeiling(input.call)))
    const line = yield* requestLine({ id, call: input.call, turn: input.turn, budget }).pipe(
      Effect.option,
    )
    if (Option.isNone(line)) return HelperReply.cases.Lost.make({ sent: false })
    const reply = yield* Deferred.make<HelperReply>()
    waiting = Option.some({ id, reply })
    const answered = yield* Effect.sync(() => child.stdin.write(`${line.value}\n`)).pipe(
      Effect.andThen(Deferred.await(reply)),
      Effect.timeoutOption(Duration.millis(budget + WATCHDOG_GRACE_MS)),
      // Interrupted or timed out, this request no longer waits; a late reply is dropped by id.
      Effect.ensuring(Effect.sync(() => forget(id))),
    )
    if (Option.isSome(answered)) return answered.value
    // The helper neither answered nor exited 70 by itself: stop the process this app spawned.
    child.kill()
    return HelperReply.cases.Lost.make({ sent: true })
  }, Semaphore.withPermit(serial))

  return { ask } satisfies Helper
})
