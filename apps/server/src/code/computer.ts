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
  /** Why the process ended when it printed no final message. Settled before `read` fails. */
  readonly ended: Effect.Effect<CodeFailure>
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
) {
  const directory = `.cache/vivid/programs/${NodeCrypto.randomUUID()}`
  // Every word is the server's own: a path from a hash, a fresh identifier, three numbers.
  const command = `[ -f '${runner.path}' ] || exit ${NOT_INSTALLED}; exec node '${runner.path}' '${directory}' ${budgets.result} ${budgets.logs} ${budgets.heap}`
  // A full queue stops the reading, which stops the provider's stream: a program that prints
  // faster than its calls are checked waits, and nothing piles up here.
  const messages = yield* Queue.bounded<WorkerMessage, PipeFailure>(budgets.calls)
  const ended = yield* Deferred.make<CodeFailure>()
  // True once the program needs no order to stop: it was given one, or it has said its last. A
  // stop written after the runner removed its directory would put the directory back.
  const settled = { now: false }

  const accept = Effect.fn('Code.guestLine')(function* (text: string) {
    if (!boundedNesting(text)) return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
    const message = yield* decodeWorker(text, { onExcessProperty: 'error' }).pipe(
      Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
    )
    if (WorkerMessage.isAnyOf(['Done', 'Failed'])(message)) settled.now = true
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
    const name = ParentMessage.match(message, {
      Start: () => 'start',
      Reply: ({ id }) => `reply-${id}`,
      Cancel: () => 'cancel',
    })
    if (ParentMessage.guards.Cancel(message)) settled.now = true
    const text = encodeParent(message)
    if (bytes(text) > budgets.wire || !boundedNesting(text))
      return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
    // The newline is how the runner knows the file is whole and not still being written.
    return yield* attachment
      .write({ path: `${directory}/in/${name}.json`, content: `${text}\n` })
      .pipe(Effect.mapError(() => new PipeFailure({ reason: 'closed' })))
  })

  // Added after the fork, so it runs before the reading is interrupted: a program nobody waits for
  // any more is told to stop. If that cannot be delivered, the provider ends it at its deadline.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (settled.now || (yield* Deferred.isDone(ended))) return
      yield* send(ParentMessage.cases.Cancel.make({})).pipe(
        Effect.timeout('10 seconds'),
        Effect.ignore,
      )
    }),
  )

  const guest: Guest = { read: Queue.take(messages), send, ended: Deferred.await(ended) }
  return guest
})

/** The Person's own Computer, woken and kept awake while the program runs. */
export const codeComputerLayer = Layer.effect(
  CodeComputer,
  Effect.gen(function* () {
    const store = yield* ComputerStore
    const runner = yield* loadRunner
    return CodeComputer.of({
      open: Effect.fn('Code.openComputer')(function* (person) {
        const attachment = yield* store
          .attach(person)
          .pipe(Effect.mapError((failure) => new CodeComputerUnavailable({ reason: failure._tag })))
        return yield* openGuest(attachment, runner)
      }),
    })
  }),
)
