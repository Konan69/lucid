import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import type { PersonId } from '@vivid/contracts'
import { CodeFailure, CodeTiming } from '@vivid/contracts/code'
import { Context, Deferred, Effect, Layer, Option, Queue, Schema, Stream, type Scope } from 'effect'
import { MachineOutput } from '../computers/machine.ts'
import { ComputerStore, type ComputerAttachment } from '../computers/store.ts'
import { boundedNesting, budgets, bytes } from './budgets.ts'
import { printed } from './lines.ts'
import {
  decodeWorker,
  encodeParent,
  ParentMessage,
  PipeFailure,
  WorkerMessage,
} from './protocol.ts'

/**
 * A program running on a Computer, as the server that supervises it sees it.
 *
 * The program is the guest: it holds no credentials and no identity, and nothing it prints is
 * believed. It can only ask (`read` gives the next thing it asked or its final message) and be
 * answered (`send`).
 */
export interface Guest {
  /** The next message the program printed. Fails `closed` once its process has ended. */
  readonly read: Effect.Effect<WorkerMessage, PipeFailure>
  /** Hands the program one message: its text to run, an answer to a call, or the order to stop. */
  readonly send: (message: ParentMessage) => Effect.Effect<void, PipeFailure>
  /**
   * Ends a program the server has given up on, and says why it has no result. It is told to stop
   * unless it is known to be over, and the reason is waited for only briefly: a Computer that has
   * stopped answering is not waited on.
   */
  readonly stopped: Effect.Effect<CodeFailure>
}

/** The Person's Computer could not be used for a program. Nothing was started on it. */
export class CodeComputerUnavailable extends Schema.TaggedError<CodeComputerUnavailable>()(
  'CodeComputerUnavailable',
  // The tag of what refused, never its message: provider text can carry private commands.
  { reason: Schema.String },
  { title: 'The Computer cannot run a program right now' },
) {}

/** The server's own runner file cannot be read: a broken installation, found at start. */
export class CodeRunnerMissing extends Schema.TaggedError<CodeRunnerMissing>()(
  'CodeRunnerMissing',
  {},
  { title: 'The program runner is missing from this installation' },
) {}

export interface CodeComputerService {
  /** Starts the runner on the Person's Computer. Closing the scope stops it. */
  readonly open: (person: PersonId) => Effect.Effect<Guest, CodeComputerUnavailable, Scope.Scope>
}

/**
 * Where programs run: the Person's Computer (decided 5 October 2026). Before that a program ran
 * in a process of the server's own host, wrapped in systemd, bubblewrap and a cgroup, which no
 * container host provides, so production refused every program. The Computer is already a machine
 * of the Person's own, kept apart by its provider; nothing is added around the program there.
 */
export class CodeComputer extends Context.Service<CodeComputer, CodeComputerService>()(
  'vivid/CodeComputer',
) {}

/** The runner's text and where it is kept on a Computer, both relative to where commands start. */
export interface Runner {
  readonly path: string
  readonly text: string
}

/**
 * Reads `guest.mjs` once. Its place on a Computer carries the hash of its text, so a server with
 * a changed runner installs its own beside the old one and never starts a stale one.
 */
export const loadRunner = Effect.try({
  try: (): Runner => {
    const text = NodeFS.readFileSync(new URL('./guest.mjs', import.meta.url), 'utf8')
    const hash = NodeCrypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
    return { text, path: `.local/share/vivid/computer/program-${hash}.mjs` }
  },
  catch: () => new CodeRunnerMissing(),
})

/** The start command's own exit code for "the runner is not on this Computer yet". */
const NOT_INSTALLED = 78

/** What the provider said about an ended process, as the reason a program has no result. */
const endedBecause = (exit: Option.Option<typeof MachineOutput.cases.Exited.Type>): CodeFailure =>
  Option.match(exit, {
    // The connection ended without the provider reporting an exit.
    onNone: () => CodeFailure.cases.Unavailable.make({}),
    onSome: (end) => {
      if (end.timedOut) return CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })
      if (end.memory) return CodeFailure.cases.OverLimit.make({ limit: 'memory' })
      return CodeFailure.cases.Unavailable.make({})
    },
  })

/**
 * Starts the runner on an attached Computer and joins its two directions.
 *
 * Out: the provider follows what the command prints, in pieces; whole lines are decoded as the
 * program's messages. In: each message is a small file the runner is watching for, because the
 * provider cannot write to a running command (Boat v1 `CommandRequest`: `stream` carries output
 * only). The first start on a Computer finds no runner, says so with its exit code, and is
 * repeated once after the file is put there.
 */
export const openGuest = Effect.fn('Code.openGuest')(function* (
  attachment: ComputerAttachment,
  runner: Runner,
  /** Where work that outlives the program is done: the removal of its directory. */
  background: Scope.Scope,
) {
  const directory = `.cache/vivid/programs/${NodeCrypto.randomUUID()}`
  // Every word is the server's own: a path from a hash, a fresh identifier, five numbers.
  const command = `[ -f '${runner.path}' ] || exit ${NOT_INSTALLED}; exec node '${runner.path}' '${directory}' ${budgets.result} ${budgets.logs} ${budgets.heap} ${budgets.calls} ${budgets.frame}`
  // A full queue stops the reading, which stops the provider's stream: a program that prints
  // faster than its calls are checked waits, and nothing piles up here.
  const messages = yield* Queue.bounded<WorkerMessage, PipeFailure>(budgets.calls)
  // Why the reading ended. It is not proof that the process did: a broken stream ends the reading
  // with the program possibly still running.
  const ended = yield* Deferred.make<CodeFailure>()
  /**
   * What is known about the process, each from its own evidence. Three of these mean the program
   * needs no order to stop: it printed its final message, it was given the order, or the provider
   * reported its exit. A stream that broke, or a line that was not a message, proves none of them.
   * `draining`: the server has given the program up, and reads on only to reach its end.
   * `waited`: word of its end has been waited for once; that wait is not repeated.
   */
  const known = { final: false, told: false, exited: false, draining: false, waited: false }

  const accept = Effect.fn('Code.guestLine')(function* (text: string) {
    if (!boundedNesting(text)) return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
    const message = yield* decodeWorker(text, { onExcessProperty: 'error' }).pipe(
      Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
    )
    if (WorkerMessage.isAnyOf(['Done', 'Failed'])(message)) known.final = true
    if (known.draining) return false
    return yield* Queue.offer(messages, message)
  })

  /** One piece of what the provider reports: printed text becomes messages, the end is kept. */
  const take = (
    reading: { rest: string; exit: Option.Option<typeof MachineOutput.cases.Exited.Type> },
    output: MachineOutput,
  ) =>
    MachineOutput.match(output, {
      Printed: Effect.fn('Code.guestPrinted')(function* ({ text }) {
        const step = printed(reading.rest, text, budgets.wire)
        if (Option.isNone(step)) return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
        reading.rest = step.value.rest
        return yield* Effect.forEach(step.value.lines, accept, { discard: true })
      }),
      Exited: (end) =>
        Effect.sync(() => {
          known.exited = true
          reading.exit = Option.some(end)
        }),
    })

  /** One run of the start command, from its first printed piece to the provider's word on its end. */
  const follow = Effect.fn('Code.followGuest')(function* () {
    const reading = { rest: '', exit: Option.none<typeof MachineOutput.cases.Exited.Type>() }
    yield* attachment
      .follow({ command, timeoutSeconds: CodeTiming.seconds + 15 })
      .pipe(Stream.runForEach((output) => take(reading, output)))
    return reading.exit
  })

  /** The first start on a Computer finds no runner; it is put there and the start is repeated once. */
  const installed = Effect.fn('Code.installedGuest')(function* () {
    const first = yield* follow()
    if (Option.isNone(first) || first.value.exitCode !== NOT_INSTALLED) return first
    // That start ran nothing; the one that follows is the program's.
    known.exited = false
    yield* attachment.write({ path: runner.path, content: runner.text })
    return yield* follow()
  })

  // The reason is settled before the queue fails, so a reader that sees `closed` can ask why.
  const close = (reason: CodeFailure, failure: PipeFailure) =>
    Deferred.succeed(ended, reason).pipe(Effect.andThen(Queue.fail(messages, failure)))
  yield* installed().pipe(
    Effect.flatMap((exit) => close(endedBecause(exit), new PipeFailure({ reason: 'closed' }))),
    // A line that was too long or was not a message: the reader is told which.
    Effect.catchTag('CodePipeFailure', (failure) =>
      close(CodeFailure.cases.Unavailable.make({}), failure),
    ),
    // The provider stopped answering. Only the tag is logged: its text can hold a command.
    Effect.catch((failure) =>
      Effect.logWarning('The Computer stopped carrying a program').pipe(
        Effect.annotateLogs({ 'vivid.computer.failure': failure._tag }),
        Effect.andThen(
          close(CodeFailure.cases.Unavailable.make({}), new PipeFailure({ reason: 'closed' })),
        ),
      ),
    ),
    Effect.forkScoped,
  )

  const send = Effect.fn('Code.sendGuest')(function* (message: ParentMessage) {
    // An answer for a program that has said its last has no reader.
    if (known.final && ParentMessage.guards.Reply(message)) return yield* Effect.void
    const name = ParentMessage.match(message, {
      Start: () => 'start',
      Reply: ({ id }) => `reply-${id}`,
      Cancel: () => 'cancel',
    })
    const text = encodeParent(message)
    if (bytes(text) > budgets.wire || !boundedNesting(text))
      return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
    // The newline is how the runner knows the file is whole and not still being written.
    yield* attachment
      .write({ path: `${directory}/in/${name}.json`, content: `${text}\n` })
      .pipe(Effect.mapError(() => new PipeFailure({ reason: 'closed' })))
    // Told only once the order is on the Computer: one that failed or was cut off is sent again.
    if (ParentMessage.guards.Cancel(message)) known.told = true
    return yield* Effect.void
  })

  /**
   * Ends a program that is not known to be over: the order to stop, then a wait for word of its
   * end, so the runner has ended what the program started and removed its directory before the
   * followed command is let go. Both are bounded by the shared timing contract; a Computer that
   * does not answer is not waited on, and its provider ends the program at the command's own
   * deadline.
   */
  const settle = Effect.fn('Code.settleGuest')(function* () {
    // What it still prints is read only to reach its end; a reader waiting on a full queue is
    // let through, because nothing in the queue will be answered now.
    known.draining = true
    yield* Queue.clear(messages).pipe(Effect.ignore)
    // Sent again by a later caller for as long as it has not been delivered.
    if (!(known.final || known.told || known.exited))
      yield* send(ParentMessage.cases.Cancel.make({})).pipe(
        Effect.timeout(CodeTiming.stopMs),
        Effect.ignore,
      )
    // A program that said its last had finished its own cleanup before it said so.
    if (known.final || known.exited || known.waited) return yield* Effect.void
    known.waited = true
    return yield* Deferred.await(ended).pipe(Effect.timeout(CodeTiming.endMs), Effect.ignore)
  })

  const stop = Effect.fn('Code.stopGuest')(function* () {
    yield* settle()
    // Known when the reading has ended; otherwise nothing more can be said about the program.
    if (yield* Deferred.isDone(ended)) return yield* Deferred.await(ended)
    return CodeFailure.cases.Unavailable.make({})
  })

  /**
   * Takes the program's directory away, whatever became of the program. The runner removes it
   * when it finishes, but a file of the server's that lands after that puts it back, and which
   * of the two came first cannot be known from here: an answer can be written while the final
   * line is still on its way. A runner that is still there and finds its directory gone ends
   * itself. This runs after the outcome is decided and is not waited for, so it costs the
   * program's caller nothing.
   */
  const remove = attachment
    .follow({ command: `rm -rf -- '${directory}'`, timeoutSeconds: 30 })
    .pipe(Stream.runDrain, Effect.timeout('30 seconds'), Effect.ignore)

  // Added after the fork, so it runs before the reading is interrupted.
  yield* Effect.addFinalizer(() =>
    settle().pipe(Effect.andThen(Effect.forkIn(remove, background)), Effect.asVoid),
  )

  const guest: Guest = { read: Queue.take(messages), send, stopped: stop() }
  return guest
})

/** The Person's own Computer, woken and kept awake while the program runs. */
export const codeComputerLayer = Layer.effect(
  CodeComputer,
  Effect.gen(function* () {
    const store = yield* ComputerStore
    const runner = yield* loadRunner
    const background = yield* Effect.scope
    return CodeComputer.of({
      open: Effect.fn('Code.openComputer')(function* (person) {
        const attachment = yield* store
          .attach(person)
          .pipe(Effect.mapError((failure) => new CodeComputerUnavailable({ reason: failure._tag })))
        return yield* openGuest(attachment, runner, background)
      }),
    })
  }),
)
