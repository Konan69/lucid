import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
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
  ComputerCall,
  ComputerLine,
  ComputerReply,
  LINE_LIMIT_BYTES,
  budgetCeiling,
  decodeLine,
  lineFramer,
  reachesWire,
  requestLine,
  ESCAPE_STOPPED,
} from './wire.ts'

/**
 * The Computer supervisor (the vendored Windows binary, `vendor/computer/`) as a supervised
 * child process.
 *
 * What the vendored binary asks of the desktop (`vendor/computer/README.md`, "How the desktop
 * app uses them") and where it is done here:
 * - one process, `--parent-pid <main pid>`, `windowsHide`, private piped stdio that never
 *   reaches a renderer (`spawnComputer`);
 * - BOTH stdout and stderr drained for as long as the process lives, stderr into a bounded ring
 *   whose content is never logged — its lines are the supervisor's own diagnostics, and nothing
 *   from another program is worth trusting into a log;
 * - one request at a time, each with its budget, under a semaphore (`ask`);
 * - an approval ask (`Approval`) is answered by the desktop itself, at once, with the approved
 *   app in the re-sent request's `meta` (`x-oai-cua-approved-app`, the reference client's own
 *   key): the Person is never asked, and nothing is persisted as refused. Four asks in a row for
 *   one request end it as refused — a loop, not a permission.
 * - a desktop watchdog of its own: a request that outlives its budget by `WATCHDOG_GRACE_MS`, a
 *   line that is not this protocol, or a line over the cap ends the process, and only the
 *   process this module spawned;
 * - exit 130 is the Person's Escape (the supervisor's own stop): it is reported as the turn's
 *   `stopped` event with no cooldown, and every request in flight is `Lost`.
 * - exit for any other reason ends the request in flight as `Lost`, never as an answer.
 *
 * The process belongs to a scope: closing it ends the process and waits for it to be gone.
 * `BeginTurn` and `Status` never reach the wire (module comment in `wire.ts`); `BeginTurn`
 * records the turn the next wire requests carry, and a change of that turn is announced with
 * `end_turn` first, the reference client's own way of ending a turn.
 */

/** The supervisor's file name, as vendored (`vendor/computer/README.md`). */
export const COMPUTER_EXECUTABLE = 'codex-computer-use.exe'
/** The engine's file name and where it sits beside the supervisor, as the reference lays it out. */
export const COMPUTER_ENGINE = 'swift/x64/codex-computer-use-swift.exe'

/**
 * How long past its own budget a request may run before the desktop stops waiting. The
 * supervisor refuses an exhausted budget itself; this is for one that does neither.
 */
export const WATCHDOG_GRACE_MS = 2_000

/** How much of the supervisor's stderr is kept: its newest bytes, and no more. */
const DIAGNOSTIC_RING_BYTES = 16 * 1024

/** How many times one request may be answered with an approval ask before it is refused. */
const APPROVAL_ROUNDS = 4

/**
 * How to start the Computer: the supervisor's program and arguments, and — when this computer
 * has the real pair — the engine beside it, which the reference's own app starts the same way
 * (`--parent-pid`). A test names a stand-in here with no engine.
 */
export interface ComputerCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly engine: Option.Option<string>
}

/**
 * Where the Computer is on this computer, when it is anywhere.
 *
 * Windows only. Packaged, it is the pair `electron-builder.yml` ships under the resources
 * directory (`native/computer`); in development it is what was vendored into the desktop app's
 * own tree (`vendor/computer`, next to `dist`). Anywhere else, and wherever the file is absent,
 * there is no Computer: nothing is spawned and this computer says it cannot do apps.
 */
export const locateComputer = (input: {
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  readonly resources: string
  /** The directory of the running main bundle (`dist/main`). */
  readonly bundle: string
  readonly parent: number
}): Option.Option<ComputerCommand> => {
  if (input.platform !== 'win32') return Option.none()
  const root = input.packaged
    ? NodePath.join(input.resources, 'native', 'computer')
    : NodePath.resolve(input.bundle, '../vendor/computer')
  const path = NodePath.join(root, COMPUTER_EXECUTABLE)
  if (!NodeFS.existsSync(path)) return Option.none()
  // The engine is the other half of the pair; without it there is no window work to do.
  const engine = NodePath.join(root, ...COMPUTER_ENGINE.split('/'))
  return NodeFS.existsSync(engine)
    ? Option.some({
        command: path,
        args: ['--parent-pid', String(input.parent)],
        engine: Option.some(engine),
      })
    : Option.none()
}

/** The Computer could not be started at all. Nothing ran. */
export class ComputerUnavailable extends Schema.TaggedError<ComputerUnavailable>()(
  'ComputerUnavailable',
  {},
  { title: 'Vivid’s Computer could not be started' },
) {}

export interface Computer {
  /**
   * Sends one request and waits for its reply. Requests are strictly one at a time. `budget` is
   * the milliseconds this request may take; it is cut to the supervisor's own ceiling for the
   * method (`wire.ts`).
   */
  readonly ask: (input: {
    readonly call: ComputerCall
    readonly turn: Option.Option<string>
    readonly budget: number
  }) => Effect.Effect<ComputerReply>
  /** Whether the process is still there: a gone Computer is started anew, never reused. */
  readonly alive: () => boolean
}

export interface ComputerListeners {
  /** The Person pressed Escape during this turn: the supervisor ended it with exit 130. */
  readonly stopped: (event: { readonly turn: string; readonly cooldown: number }) => void
  /** The process is gone, for any reason. Said once. */
  readonly gone: () => void
}

/** The request waiting for its reply. There is at most one. */
interface Waiting {
  readonly id: number
  readonly reply: Deferred.Deferred<ComputerReply>
  /** The request as written, so an approval ask can be answered with the same request again. */
  readonly line: string
  readonly app: (approval: string) => string
  rounds: number
}

/**
 * Starts the process and returns the wires to it. The narrow unsafe part of this module: Node's
 * `spawn` and its event emitters. The release step ends the process this call spawned (never one
 * found by name) and waits until Node reports it gone, so a closed scope leaves nothing running.
 */
const spawnComputer = Effect.fn('DesktopComputer.spawn')(function* (command: ComputerCommand) {
  const ended = yield* Deferred.make<void>()
  // The engine runs beside the supervisor, the reference's own way: same `--parent-pid`, hidden,
  // and ended with the same scope. It is not talked to; the pair finds each other itself.
  const engine = Option.map(command.engine, (path) =>
    NodeChildProcess.spawn(path, ['--parent-pid', String(NodeProcess.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    }),
  )
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        NodeChildProcess.spawn(command.command, [...command.args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }),
      catch: () => new ComputerUnavailable({}),
    }),
    (spawned) =>
      Effect.sync(() => {
        Option.map(engine, (process_) => process_.kill())
        spawned.kill()
      }).pipe(Effect.andThen(Deferred.await(ended)), Effect.asVoid),
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
 * Starts the Computer in the current scope.
 *
 * Replies are matched to requests by id. A reply whose id is not the one waiting belongs to a
 * request this app stopped waiting for (the Person pressed Stop while it ran) and is dropped.
 */
export const startComputer = Effect.fn('DesktopComputer.start')(function* (
  command: ComputerCommand,
  listeners: ComputerListeners,
) {
  const { child, ended } = yield* spawnComputer(command)
  const serial = yield* Semaphore.make(1)
  const frame = lineFramer(LINE_LIMIT_BYTES)
  let waiting = Option.none<Waiting>()
  let gone = false
  let next = 1
  let diagnostics = Buffer.alloc(0)
  /** The turn the last wire request carried: an `end_turn` is sent before a different one. */
  let wireTurn = Option.none<string>()

  const lose = (): void => {
    Option.map(waiting, (current) =>
      Deferred.doneUnsafe(
        current.reply,
        Effect.succeed(ComputerReply.cases.Lost.make({ sent: true })),
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
  /** Writes a line to the supervisor, ignoring a failing pipe: the exit ends the request. */
  const write = (line: string): void => {
    child.stdin.write(`${line}\n`, () => undefined)
  }
  const heard = (line: ComputerLine): void =>
    ComputerLine.match(line, {
      Stopped: ({ turn, cooldown }) => listeners.stopped({ turn, cooldown }),
      Reply: ({ id, reply }) => {
        const current = Option.filter(waiting, (candidate) => candidate.id === id)
        if (Option.isNone(current)) return
        waiting = Option.none()
        Deferred.doneUnsafe(current.value.reply, Effect.succeed(reply))
      },
      Approval: ({ id, app }) => {
        const current = Option.filter(waiting, (candidate) => candidate.id === id)
        if (Option.isNone(current)) return
        const pending = current.value
        pending.rounds += 1
        if (pending.rounds >= APPROVAL_ROUNDS) {
          waiting = Option.none()
          Deferred.doneUnsafe(
            pending.reply,
            Effect.succeed(
              ComputerReply.cases.Refused.make({
                name: 'NotApproved',
                delivered: Option.none(),
                reason: Option.none(),
              }),
            ),
          )
          return
        }
        // The reference client's own answer to an approval ask: the same request again, with the
        // approved app merged into its `meta`. Nothing is asked of the Person.
        write(pending.app(app))
      },
    })
  child.stdout.on('data', (chunk: Buffer) => {
    for (const framed of frame(chunk))
      Framed.match(framed, {
        TooLong: distrust,
        Line: ({ text }) => Option.match(decodeLine(text), { onNone: distrust, onSome: heard }),
      })
  })
  // Drained so a full pipe can never block the supervisor; kept bounded; read by nobody but a
  // developer with a debugger. Not logged: see the module comment.
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = Buffer.concat([diagnostics, chunk]).subarray(-DIAGNOSTIC_RING_BYTES)
  })
  yield* Effect.forkScoped(
    Deferred.await(ended).pipe(
      Effect.andThen(
        Effect.sync(() => {
          gone = true
          const escape = child.exitCode === 130
          const escapeTurn = Option.getOrUndefined(wireTurn)
          if (escape && escapeTurn !== undefined) {
            // Escape ends any request in flight with the supervisor's own message for it, and
            // says the turn's stop, exactly as a refusal: both roads end in the same answer.
            const inFlight = waiting
            waiting = Option.none()
            Option.map(inFlight, (pending) =>
              Deferred.doneUnsafe(
                pending.reply,
                Effect.succeed(
                  ComputerReply.cases.Refused.make({
                    name: ESCAPE_STOPPED,
                    delivered: Option.none(),
                    reason: Option.none(),
                  }),
                ),
              ),
            )
          } else {
            lose()
          }
          // The exit code and how much it said, never what it said.
          console.info(
            `desktop: Vivid's Computer ended (code ${String(child.exitCode)}, ${diagnostics.length} bytes of diagnostics)`,
          )
          if (escape && escapeTurn !== undefined)
            listeners.stopped({ turn: escapeTurn, cooldown: 0 })
          listeners.gone()
        }),
      ),
    ),
  )

  const ask: Computer['ask'] = Effect.fn('DesktopComputer.ask')(function* (input) {
    if (gone) return ComputerReply.cases.Lost.make({ sent: false })
    // The turn switch is announced first, the reference client's own way: one turn at a time on
    // the wire, and `end_turn` before a different turn's request. A failed announcement changes
    // nothing — the request itself is what carries the new turn's `meta`.
    const turnChanged =
      Option.isSome(input.turn) &&
      Option.isSome(wireTurn) &&
      input.turn.value !== wireTurn.value
    if (turnChanged) {
      const farewell = yield* requestLine({
        id: next,
        call: ComputerCall.cases.EndTurn.make({}),
        turn: wireTurn,
        budget: budgetCeiling(ComputerCall.cases.EndTurn.make({})),
      }).pipe(Effect.option)
      if (Option.isSome(farewell)) write(farewell.value)
      next += 1
    }
    // Calls that stay local are answered here: the turn has begun as far as the desktop is
    // concerned, and the first wire request carries it (`wire.ts`, module comment).
    if (!reachesWire(input.call)) {
      wireTurn = input.turn
      return ComputerReply.cases.Answered.make({ result: {} })
    }
    const id = next
    next += 1
    const budget = Math.max(0, Math.min(Math.floor(input.budget), budgetCeiling(input.call)))
    const line = yield* requestLine({ id, call: input.call, turn: input.turn, budget }).pipe(
      Effect.option,
    )
    if (Option.isNone(line) || line.value === '') return ComputerReply.cases.Lost.make({ sent: false })
    wireTurn = input.turn
    const reply = yield* Deferred.make<ComputerReply>()
    /** Answers one approval ask: the same line with the approved app merged into its `meta`. */
    const approved = (approval: string): string => {
      const request = JSON.parse(line.value) as {
        meta?: Record<string, unknown>
        [key: string]: unknown
      }
      request.meta = { ...request.meta, 'x-oai-cua-approved-app': approval }
      return JSON.stringify(request)
    }
    waiting = Option.some({ id, reply, line: line.value, app: approved, rounds: 0 })
    const answered = yield* Effect.sync(() => write(line.value)).pipe(
      Effect.andThen(Deferred.await(reply)),
      Effect.timeoutOption(Duration.millis(budget + WATCHDOG_GRACE_MS)),
      // Interrupted or timed out, this request no longer waits; a late reply is dropped by id.
      Effect.ensuring(Effect.sync(() => forget(id))),
    )
    if (Option.isSome(answered)) return answered.value
    // The supervisor neither answered nor stopped by itself: end the process this app spawned.
    child.kill()
    return ComputerReply.cases.Lost.make({ sent: true })
  }, Semaphore.withPermit(serial))

  return { ask, alive: () => !gone } satisfies Computer
})
