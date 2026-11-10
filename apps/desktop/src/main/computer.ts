import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import {
  Framed,
  ComputerCall,
  ComputerLine,
  ComputerReply,
  LINE_LIMIT_BYTES,
  ESCAPE_STOPPED,
  budgetCeiling,
  decodeLine,
  lineFramer,
  reachesWire,
  requestLine,
} from './wire.ts'

/**
 * The Computer supervisor (the vendored Windows binary, `vendor/computer/`) as a supervised
 * child process.
 *
 * What the vendored binary asks of the desktop (`vendor/computer/README.md`, "How the desktop
 * app uses them") and where it is done here:
 * - one process, `--parent-pid <main pid>`, `windowsHide`, private piped stdio that never
 *   reaches a renderer (`spawnComputer`), with the engine beside it started the reference's own
 *   way and ended with the same scope;
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
 *   `stopped` event with no cooldown, and the request in flight is refused with the supervisor's
 *   own Escape message, so both roads end in the same answer. Exit for any other reason ends the
 *   request in flight as `Lost`, never as an answer.
 *
 * The process belongs to a scope: closing it ends the process and waits for it to be gone.
 * `BeginTurn` and `Status` never reach the wire (module comment in `wire.ts`); `BeginTurn`
 * records the turn the next wire requests carry, and a change of that turn is announced with
 * `end_turn` first, the reference client's own way of ending a turn.
 */

/** The supervisor's file name, as vendored (`vendor/computer/README.md`). */
const COMPUTER_EXECUTABLE = 'codex-computer-use.exe'
/** The engine's file name and where it sits beside the supervisor, as the reference lays it out. */
const COMPUTER_ENGINE = 'swift/x64/codex-computer-use-swift.exe'

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
class ComputerUnavailable extends Schema.TaggedError<ComputerUnavailable>()(
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
  /** The request as asked, so an approval ask can be answered with the same request again. */
  readonly asked: {
    readonly call: ComputerCall
    readonly turn: Option.Option<string>
    readonly budget: number
  }
  rounds: number
}

/** What the wires to one Computer process remember while it lives. */
interface Bus {
  waiting: Option.Option<Waiting>
  /** The turn the last wire request carried: an `end_turn` is sent before a different one. */
  wireTurn: Option.Option<string>
  gone: boolean
  next: number
  diagnostics: Buffer
}

const newBus = (): Bus => ({
  waiting: Option.none(),
  wireTurn: Option.none(),
  gone: false,
  next: 1,
  diagnostics: Buffer.alloc(0),
})

/**
 * Starts the process and returns the wires to it. The narrow unsafe part of this module: Node's
 * `spawn` and its event emitters. The release step ends the process this call spawned (never one
 * found by name) and waits until Node reports it gone, so a closed scope leaves nothing running.
 * The engine, when there is one, runs beside the supervisor — the reference's own way, same
 * `--parent-pid`, hidden — and is ended with it.
 */
const spawnComputer = Effect.fn('DesktopComputer.spawn')(function* (command: ComputerCommand) {
  const ended = yield* Deferred.make<void>()
  const engine = Option.map(command.engine, (path) =>
    NodeChildProcess.spawn(path, ['--parent-pid', String(NodeProcess.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    }),
  )
  const stopAll = (spawned: NodeChildProcess.ChildProcess): void => {
    Option.map(engine, (running) => running.kill())
    spawned.kill()
  }
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
      Effect.sync(() => stopAll(spawned)).pipe(
        Effect.andThen(Deferred.await(ended)),
        Effect.asVoid,
      ),
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

/** The reply that ends a request in flight when the process is gone without an answer. */
const lost = (sent: boolean) => ComputerReply.cases.Lost.make({ sent })

/** Ends the request in flight, if there is one, as `Lost`: no answer will come. */
const lose = (bus: Bus): void => {
  Option.map(bus.waiting, (pending) =>
    Deferred.doneUnsafe(pending.reply, Effect.succeed(lost(true))),
  )
  bus.waiting = Option.none()
}

/** The reply the supervisor sends for a turn the Person stopped: the in-flight request's refusal. */
const escapeRefusal = () =>
  ComputerReply.cases.Refused.make({
    name: ESCAPE_STOPPED,
    delivered: Option.none(),
    reason: Option.none(),
  })

/**
 * The process ended: nothing answers after this. Escape (exit 130) says the turn's stop and
 * refuses the request in flight with the supervisor's own message for it; any other exit ends
 * the request as lost.
 */
const onEnded = (
  bus: Bus,
  child: NodeChildProcess.ChildProcess,
  listeners: ComputerListeners,
): void => {
  bus.gone = true
  const escapeTurn = bus.wireTurn
  const escape = child.exitCode === 130 && Option.isSome(escapeTurn)
  if (escape) {
    const inFlight = bus.waiting
    bus.waiting = Option.none()
    Option.map(inFlight, (pending) =>
      Deferred.doneUnsafe(pending.reply, Effect.succeed(escapeRefusal())),
    )
  } else {
    lose(bus)
  }
  // The exit code and how much it said, never what it said.
  console.info(
    `desktop: Vivid's Computer ended (code ${String(child.exitCode)}, ${bus.diagnostics.length} bytes of diagnostics)`,
  )
  if (escape && Option.isSome(escapeTurn))
    listeners.stopped({ turn: escapeTurn.value, cooldown: 0 })
  listeners.gone()
}

/**
 * Answers one approval ask: the same request again with the approved app in its `meta`, the
 * reference client's own answer — until the supervisor takes it or the ask has come back too
 * many times to be one.
 */
const resendApproval =
  (bus: Bus, write: (line: string) => void) =>
  (ask: { readonly id: number; readonly app: string }) =>
    Effect.gen(function* () {
      const current = Option.filter(bus.waiting, (candidate) => candidate.id === ask.id)
      if (Option.isNone(current)) return
      const pending = current.value
      pending.rounds += 1
      if (pending.rounds >= APPROVAL_ROUNDS) {
        bus.waiting = Option.none()
        Deferred.doneUnsafe(pending.reply, Effect.succeed(escapeRefusal()))
        return
      }
      const line = yield* requestLine({
        id: pending.id,
        call: pending.asked.call,
        turn: pending.asked.turn,
        budget: pending.asked.budget,
        approvedApp: Option.some(ask.app),
      }).pipe(Effect.option)
      if (Option.isSome(line)) write(line.value)
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
  const bus = newBus()
  const serial = yield* Semaphore.make(1)
  /** Approval asks waiting for their re-send, answered by the desktop itself (module comment). */
  const approvals = yield* Queue.unbounded<{ readonly id: number; readonly app: string }>()
  const frame = lineFramer(LINE_LIMIT_BYTES)

  /** Writes a line to the supervisor, ignoring a failing pipe: the exit ends the request. */
  const write = (line: string): void => {
    child.stdin.write(`${line}\n`, () => undefined)
  }
  const forget = (id: number): void => {
    bus.waiting = Option.filter(bus.waiting, (current) => current.id !== id)
  }
  /** The stream is no longer this protocol: stop reading it and end the process. */
  const distrust = (): void => {
    lose(bus)
    child.kill()
  }
  const heard = (line: ComputerLine): void =>
    ComputerLine.match(line, {
      Stopped: ({ turn, cooldown }) => listeners.stopped({ turn, cooldown }),
      Reply: ({ id, reply }) => {
        const current = Option.filter(bus.waiting, (candidate) => candidate.id === id)
        if (Option.isNone(current)) return
        bus.waiting = Option.none()
        Deferred.doneUnsafe(current.value.reply, Effect.succeed(reply))
      },
      Approval: ({ id, app }) => {
        // The reference client's own answer to an approval ask: the same request again, with the
        // approved app merged into its `meta`. Nothing is asked of the Person. The re-send runs
        // on its own fiber, since encoding a line is an Effect.
        Queue.offerUnsafe(approvals, { id, app })
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
    bus.diagnostics = Buffer.concat([bus.diagnostics, chunk]).subarray(-DIAGNOSTIC_RING_BYTES)
  })

  // Answers approval asks, one at a time: the same request again with the approved app in its
  // `meta`, until the supervisor takes it or the ask has come back too many times to be one.
  yield* Effect.forkScoped(
    Queue.take(approvals).pipe(Effect.flatMap(resendApproval(bus, write)), Effect.forever),
  )

  // The process ended: nothing answers after this (`onEnded`).
  yield* Effect.forkScoped(
    Deferred.await(ended).pipe(Effect.andThen(Effect.sync(() => onEnded(bus, child, listeners)))),
  )

  const ask: Computer['ask'] = Effect.fn('DesktopComputer.ask')(function* (input) {
    if (bus.gone) return lost(false)
    // The turn switch is announced first, the reference client's own way: one turn at a time on
    // the wire, and `end_turn` before a different turn's request. A failed announcement changes
    // nothing — the request itself is what carries the new turn's `meta`.
    const turnChanged =
      Option.isSome(input.turn) &&
      Option.isSome(bus.wireTurn) &&
      input.turn.value !== bus.wireTurn.value
    if (turnChanged) {
      const farewell = yield* requestLine({
        id: bus.next,
        call: ComputerCall.cases.EndTurn.make({}),
        turn: bus.wireTurn,
        budget: budgetCeiling(ComputerCall.cases.EndTurn.make({})),
        approvedApp: Option.none(),
      }).pipe(Effect.option)
      if (Option.isSome(farewell)) write(farewell.value)
      bus.next += 1
    }
    // Calls that stay local are answered here: the turn has begun as far as the desktop is
    // concerned, and the first wire request carries it (`wire.ts`, module comment).
    if (!reachesWire(input.call)) {
      bus.wireTurn = input.turn
      return ComputerReply.cases.Answered.make({ result: {} })
    }
    const id = bus.next
    bus.next += 1
    const budget = Math.max(0, Math.min(Math.floor(input.budget), budgetCeiling(input.call)))
    const line = yield* requestLine({
      id,
      call: input.call,
      turn: input.turn,
      budget,
      approvedApp: Option.none(),
    }).pipe(Effect.option)
    if (Option.isNone(line) || line.value === '') return lost(false)
    bus.wireTurn = input.turn
    const reply = yield* Deferred.make<ComputerReply>()
    bus.waiting = Option.some({
      id,
      reply,
      asked: { call: input.call, turn: input.turn, budget },
      rounds: 0,
    })
    const answered = yield* Effect.sync(() => write(line.value)).pipe(
      Effect.andThen(Deferred.await(reply)),
      Effect.timeoutOption(Duration.millis(budget + WATCHDOG_GRACE_MS)),
      // Interrupted or timed out, this request no longer waits; a late reply is dropped by id.
      Effect.ensuring(Effect.sync(() => forget(id))),
    )
    if (Option.isSome(answered)) return answered.value
    // The supervisor neither answered nor stopped by itself: end the process this app spawned.
    child.kill()
    return lost(true)
  }, Semaphore.withPermit(serial))

  return { ask, alive: () => !bus.gone } satisfies Computer
})
