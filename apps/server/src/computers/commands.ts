import * as NodeFS from 'node:fs'
import { Cause, Effect, Layer, Option, Schedule, Schema, Stream } from 'effect'
import * as PersistedQueue from 'effect/persistence/PersistedQueue'
import {
  Forbidden,
  DatabaseFailure,
  PersonId,
  ShellHandle,
  ShellSnapshot,
  SignalCue,
  ThreadId,
  type StartShellRequest,
  type WaitShellRequest,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import {
  noteRunning,
  noteUnreachable,
  owesWake,
  recordCommand,
  releaseCommand,
} from './background.ts'
import { MachineOperationFailed, MachineResponseInvalid } from './machine.ts'
import { ComputerStore, executionRefusals, executionReason } from './store.ts'

/** The queue owns the wake obligation, not the command's process lifetime or output. */
const Command = Schema.Struct({
  handle: ShellHandle,
  personId: PersonId,
  threadId: ThreadId,
  command: Schema.String,
  directory: Schema.String,
})
type Command = typeof Command.Type

/** Five-second status cadence matches the reference shell receipt refresh. Native queue retry
 * stores the next attempt in SQL, so no process-local timer owns a completion obligation.
 * Source-verified: Effect PersistedQueue.ts take's scoped finalizer retries on failure, releases
 * on interruption, and acknowledges only success. Delivery uses the handle as its dedupe key.
 * Its finite int32 ceiling and malformed-payload dead letters remain SDK limits. */
export const commandQueue = PersistedQueue.make({
  name: 'computer-shell',
  schema: Command,
  maxAttempts: 2147483647,
  retrySchedule: Schedule.spaced('5 seconds'),
})

class CommandPending extends Schema.TaggedError<CommandPending>()(
  'CommandPending',
  {},
  { title: 'Command still running' },
) {}

/** Quote source and JSON as single arguments; neither command text nor paths become shell syntax. */
const word = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** This Python adapter runs on the Computer, never the server. The source must ship beside it. */
const invocation = Effect.fn('Shell.invocation')(function* (
  handle: ShellHandle,
  action: 'start' | 'read' | 'wait' | 'stop',
  argument: string,
) {
  const source = yield* Effect.try({
    try: () => NodeFS.readFileSync(new URL('./command.py', import.meta.url), 'utf8'),
    catch: () => new MachineOperationFailed({ operation: 'shell-supervisor-source' }),
  })
  // The SSH account may use fish before bash starts. Keep multiline source and its quotes
  // out of both shells' syntax; only the Python boundary decodes it.
  const encoded = Buffer.from(source).toString('base64')
  return `python3 -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' ${encoded} ${action} ${word(handle)} ${word(argument)}`
})

/** Unknown JSON from the Computer is decoded once. A broken supervisor never becomes a receipt. */
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(ShellSnapshot))
const decode = (text: string) =>
  decodeSnapshot(text).pipe(
    Effect.mapError(() => new MachineResponseInvalid({ operation: 'shell-receipt' })),
  )

/** Replaying a launch only reads an existing handle; the Computer reserves it before spawning.
 * Store.run owns the takeover check. The command detaches before this short action returns. */
export const launchCommand = Effect.fn('Shell.launch')(function* (job: Command) {
  const store = yield* ComputerStore
  const payload = Buffer.from(
    JSON.stringify({ command: job.command, directory: job.directory }),
  ).toString('base64')
  const command = yield* invocation(job.handle, 'start', payload)
  const result = yield* store.run(job.personId, { command, directory: '.', timeoutSeconds: 30 })
  if (result.exitCode !== 0) return yield* new MachineResponseInvalid({ operation: 'shell-launch' })
  return yield* decode(result.stdout)
})

/** A wait holds presence, not the Computer action permit, so independent tools can keep working.
 * Cancelling the RPC closes only this observer; the detached supervisor keeps running. */
export const observeCommand = Effect.fn('Shell.observe')(function* (
  personId: PersonId,
  action: 'read' | 'wait' | 'stop',
  request: WaitShellRequest,
) {
  const store = yield* ComputerStore
  const command = yield* invocation(request.handle, action, String(request.seconds))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const attached = yield* store.attach(personId)
      const observer = yield* attached.converse({ command, timeoutSeconds: request.seconds + 30 })
      const text = yield* Stream.runFold(
        observer.output,
        () => '',
        (collected, next) => collected + next,
      )
      const end = yield* observer.ended
      if (end.exitCode !== 0)
        return yield* new MachineResponseInvalid({ operation: 'shell-observe' })
      return yield* decode(text)
    }),
  )
})

/** Offer before starting: a server killed after any accepted launch still owes its Thread a wake. */
export const startShell = Effect.fn('Shell.start')(function* (
  actor: Actor,
  request: StartShellRequest,
) {
  if (Option.isNone(actor.threadId))
    return yield* new Forbidden({ message: 'Shell work needs a Thread.' })
  const job = Command.make({
    ...request,
    handle: ShellHandle.make(crypto.randomUUID()),
    personId: actor.person.id,
    threadId: actor.threadId.value,
  })
  const queue = yield* commandQueue
  yield* queue
    .offer(job, { id: job.handle })
    .pipe(
      Effect.mapError(
        () => new DatabaseFailure({ message: 'Shell completion could not be queued.' }),
      ),
    )
  // After the queue entry, so a listed command always has a wake owed; a server stopped in between
  // leaves the queue's first read to write the row (`noteRunning`).
  yield* recordCommand(job)
  // An accepted queue entry still owns its handle when the Computer is temporarily unavailable.
  // Returning an ordinary refusal here would invite a second command while the first remains owed.
  const queued = Effect.succeed(ShellSnapshot.cases.Queued.make({ handle: job.handle }))
  return yield* launchCommand(job).pipe(
    Effect.catchTag('MachineExecutionUnknown', () => queued),
    Effect.catchTags(executionRefusals(() => queued)),
  )
})

/** Operational failures remain explicit to the model; the queue retains its wake obligation. */
export const shellRefusals = {
  ...executionRefusals((failure) =>
    Effect.succeed(ShellSnapshot.cases.Unavailable.make({ reason: executionReason(failure) })),
  ),
  MachineExecutionUnknown: () =>
    Effect.succeed(
      ShellSnapshot.cases.Unavailable.make({
        reason:
          'The Computer connection was lost. The queued handle remains owed; check it before starting another command.',
      }),
    ),
}

/** Hands a command's final receipt to its Thread, once whatever retries: keyed by its handle. */
const wake = Effect.fn('Shell.wake')(function* (job: Command, result: ShellSnapshot) {
  const conversation = yield* Conversation
  return yield* conversation.deliver({
    personId: job.personId,
    threadId: job.threadId,
    speaker: DeliverySpeaker.cases.Vivid.make({}),
    message: DeliveryMessage.cases.Signal.make({
      cue: SignalCue.cases.Shell.make({ body: JSON.stringify(result), handle: job.handle }),
    }),
    origin: StoredRunOrigin.cases.Decision.make({}),
    idempotencyKey: `shell:${job.handle}`,
  })
})

/** Retry running commands through the native SQL queue. Terminal delivery is idempotent even
 * when the server dies after admission and before the queue's success acknowledgement. Each read
 * of the receipt is written down for the work view (`background.ts`), which never asks the
 * Computer itself; the row leaves once the Thread has its wake, or was spared it by a Stop. */
export const completeCommand = Effect.fn('Shell.complete')(function* (job: Command) {
  const result = yield* launchCommand(job).pipe(
    Effect.tapError((failure) => noteUnreachable(job, executionReason(failure))),
  )
  if (ShellSnapshot.guards.Running(result)) {
    yield* noteRunning(job, result)
    return yield* new CommandPending()
  }
  if (yield* owesWake(job.handle, result)) yield* wake(job, result)
  yield* releaseCommand(job)
})

/** SQL persists pending retries across restart. Shutdown releases the claimed row; non-interrupt
 * consumer failures restart here without acknowledging the command or losing its wake. */
export const commandWorkerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const queue = yield* commandQueue
    yield* queue.take(completeCommand).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Cause.hasFails(cause) &&
          cause.reasons.every(
            (reason) => Cause.isFailReason(reason) && reason.error instanceof CommandPending,
          )
            ? Effect.void
            : Effect.logWarning('Shell completion remains queued.'),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
  }),
)
