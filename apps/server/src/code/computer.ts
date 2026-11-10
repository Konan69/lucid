import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import type { PersonId } from '@vivid/contracts'
import { CodeCallKind, CodeFailure, CodeTiming } from '@vivid/contracts/code'
import { Context, Deferred, Effect, Layer, Option, Queue, Schema, Stream, type Scope } from 'effect'
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

/** Post-cancellation write grace. Source: unmeasured. Expiry lets the enclosing scope
 * close the SSH command even when its stdin callback never arrives. */
const CANCEL_WRITE_GRACE = CodeTiming.stopMs
/** Post-cancellation exit grace. Source: unmeasured. A missing final receipt is Unavailable. */
const CANCEL_EXIT_GRACE = CodeTiming.endMs

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
class CodeComputerUnavailable extends Schema.TaggedError<CodeComputerUnavailable>()(
  'CodeComputerUnavailable',
  // The tag of what refused, never its message: provider text can carry private commands.
  { reason: Schema.String },
  { title: 'The Computer cannot run a program right now' },
) {}

/** The server's own runner file cannot be read: a broken installation, found at start. */
class CodeRunnerMissing extends Schema.TaggedError<CodeRunnerMissing>()(
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

/** The start command's own exit code for "the runner is not on this Computer". */
const NOT_INSTALLED = 78

/** How the runner's process ended, as the reason a program has no result. */
const endedBecause = (end: { readonly timedOut: boolean }): CodeFailure =>
  end.timedOut
    ? CodeFailure.cases.TimedOut.make({ seconds: budgets.seconds })
    : CodeFailure.cases.Unavailable.make({})

/**
 * Starts the runner on an attached Computer and joins its two directions.
 *
 * The runner is one command on the Computer's SSH connection (`computers/ssh/link.ts`,
 * `converse`). A message from the program is one line it prints; a message to it is one line
 * written to its standard input. Until 10 October 2026 the answers were small files the runner
 * watched for, written through the provider's API, because the provider could follow a command's
 * output but not write to it. The SSH channel carries both directions, so there is no directory
 * of the program's on the Computer, nothing to remove afterwards, and no question of an answer
 * landing after the runner has gone.
 *
 * The scope owns the command: when it closes, the Computer signals the runner and everything it
 * started. A program the server gives up on therefore needs no order to stop and no wait.
 * `missing` is called when the Computer says the runner is not there.
 */
export const openGuest = Effect.fn('Code.openGuest')(function* (
  attachment: ComputerAttachment,
  runner: Runner,
  missing: Effect.Effect<void>,
) {
  // Only authored kinds enter the shell, as one comma-separated word; no program input is interpolated.
  const command = `[ -f '${runner.path}' ] || exit ${NOT_INSTALLED}; exec node '${runner.path}' ${budgets.result} ${budgets.logs} ${budgets.calls} ${budgets.frame} ${CodeCallKind.literals.join(',')}`
  const spoken = yield* attachment
    .converse({ command, timeoutSeconds: CodeTiming.seconds + 15 })
    .pipe(Effect.mapError((failure) => new CodeComputerUnavailable({ reason: failure._tag })))
  const messages = yield* Queue.unbounded<WorkerMessage, PipeFailure>()
  /** Why the reading ended: the runner's own word when it gave one, else how its process ended. */
  const ended = yield* Deferred.make<CodeFailure>()
  const known = { final: false, said: Option.none<CodeFailure>() }

  const accept = Effect.fn('Code.guestLine')(function* (text: string) {
    if (!boundedNesting(text)) return yield* new PipeFailure({ reason: 'size' })
    const message = yield* decodeWorker(text, { onExcessProperty: 'error' }).pipe(
      Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
    )
    if (WorkerMessage.isAnyOf(['Done', 'Failed'])(message)) known.final = true
    // The program's own word on why it has no result is the truer reason, and is kept for
    // whoever asks why the reading ended.
    if (WorkerMessage.guards.Failed(message)) known.said = Option.some(message.failure)
    return yield* Queue.offer(messages, message)
  })

  // The reason is settled before the queue fails, so a reader that sees `closed` can ask why.
  const close = (reason: CodeFailure, failure: PipeFailure) =>
    Deferred.succeed(ended, reason).pipe(Effect.andThen(Queue.fail(messages, failure)))
  const reading = { rest: '' }
  yield* spoken.output.pipe(
    Stream.runForEach(
      Effect.fn('Code.guestPrinted')(function* (text: string) {
        const step = printed(reading.rest, text, budgets.wire)
        if (Option.isNone(step)) return yield* new PipeFailure({ reason: 'size' })
        reading.rest = step.value.rest
        return yield* Effect.forEach(step.value.lines, accept, { discard: true })
      }),
    ),
    Effect.andThen(spoken.ended),
    Effect.tap((end) => (end.exitCode === NOT_INSTALLED ? missing : Effect.void)),
    Effect.flatMap((end) =>
      close(
        Option.getOrElse(known.said, () => endedBecause(end)),
        new PipeFailure({ reason: 'closed' }),
      ),
    ),
    // A line that was too long or was not a message: the reader is told which.
    Effect.catchTag('CodePipeFailure', (failure) =>
      close(CodeFailure.cases.Unavailable.make({}), failure),
    ),
    // The connection to the Computer went. Only the tag is logged: its text can hold a command.
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
    // An order that will not encode is as unusable as one that will not decode: nothing is sent.
    const text = yield* encodeParent(message).pipe(
      Effect.mapError(() => new PipeFailure({ reason: 'invalid' })),
    )
    if (bytes(text) > budgets.wire || !boundedNesting(text))
      return yield* new PipeFailure({ reason: 'size' })
    return yield* spoken
      .say(`${text}\n`)
      .pipe(Effect.mapError(() => new PipeFailure({ reason: 'closed' })))
  })

  /**
   * Why a program the server has given up on has no result. A runner that is not known to be
   * over is told to stop, which makes it say what the program printed and how it ended; word of
   * that is waited for only briefly. A Computer that has stopped answering is not waited on, and
   * the scope ends the runner whatever it does.
   */
  const stop = Effect.fn('Code.stopGuest')(function* () {
    if (!(known.final || (yield* Deferred.isDone(ended))))
      yield* send(ParentMessage.cases.Cancel.make({})).pipe(
        Effect.timeout(CANCEL_WRITE_GRACE),
        Effect.ignore,
      )
    yield* Deferred.await(ended).pipe(Effect.timeout(CANCEL_EXIT_GRACE), Effect.ignore)
    if (yield* Deferred.isDone(ended)) return yield* Deferred.await(ended)
    return CodeFailure.cases.Unavailable.make({})
  })

  const guest: Guest = { read: Queue.take(messages), send, stopped: stop() }
  return guest
})

/**
 * Puts the runner on a Computer that does not have it. Asked once for each Person in the life of
 * this server, and again after a Computer has said the runner is gone (a machine that was
 * replaced or rolled back).
 */
export const installRunner = Effect.fn('Code.installRunner')(function* (
  attachment: ComputerAttachment,
  runner: Runner,
) {
  const there = yield* attachment
    .converse({ command: `[ -f '${runner.path}' ]`, timeoutSeconds: null })
    .pipe(
      Effect.flatMap((spoken) => spoken.ended),
      Effect.map((end) => end.exitCode === 0),
      Effect.scoped,
    )
  if (!there) yield* attachment.write({ path: runner.path, content: runner.text })
})

/** The Person's own Computer, woken and kept awake while the program runs. */
export const codeComputerLayer = Layer.effect(
  CodeComputer,
  Effect.gen(function* () {
    const store = yield* ComputerStore
    const runner = yield* loadRunner
    /** The Persons whose Computer is known to hold this server's runner. */
    const installed = new Set<PersonId>()
    return CodeComputer.of({
      open: Effect.fn('Code.openComputer')(function* (person) {
        const unusable = (failure: { readonly _tag: string }) =>
          new CodeComputerUnavailable({ reason: failure._tag })
        const attachment = yield* store.attach(person).pipe(Effect.mapError(unusable))
        if (!installed.has(person)) {
          yield* installRunner(attachment, runner).pipe(Effect.mapError(unusable))
          installed.add(person)
        }
        return yield* openGuest(
          attachment,
          runner,
          Effect.sync(() => installed.delete(person)).pipe(
            Effect.andThen(Effect.logWarning('The Computer no longer holds the program runner')),
          ),
        )
      }),
    })
  }),
)
