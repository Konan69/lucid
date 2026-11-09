import * as NodeCrypto from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Clock, Effect } from 'effect'
import {
  BackgroundWork,
  COMMAND_SHOWN,
  CommandUnreachable,
  ShellSnapshot,
  type PersonId,
  type ShellHandle,
  type ThreadId,
} from '@vivid/contracts'
import { ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, encodeStored } from '../database/client.ts'
import { announce, Topic } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import { computerCommands } from './tables.ts'

/**
 * The server's record of each command Vivid left running in the background on a Person's Computer,
 * which is what the work view lists (`work/list.ts`). The `computer-shell` queue reads the
 * command's receipt every five seconds while it runs (`commands.ts` `completeCommand`); each read
 * leaves here what the list needs, so listing never reaches the Computer and never wakes one.
 *
 * Every write announces the Person's `feed` part, which `WatchWork` reads, on the same transaction.
 */

/** What a background command is, as the queue entry that owes its wake carries it. */
export interface StartedCommand {
  readonly handle: ShellHandle
  readonly personId: PersonId
  readonly threadId: ThreadId
  readonly command: string
}

type Running = Extract<ShellSnapshot, { _tag: 'Running' }>

/**
 * How often output that keeps changing is written down. Standing reads `output_at` against a
 * twenty-minute stall (`RUN_WORKING_LONG_MS`), so a minute is precise enough, and a command that
 * prints all the time writes once a minute instead of on every five-second read.
 */
const OUTPUT_RESOLUTION_MS = 60_000

const decodeUnreachable = decodeStored(CommandUnreachable, 'command reachability')
const encodeUnreachable = encodeStored(CommandUnreachable, 'command reachability')

/** The receipt's two output tails, as one value that changes when either does. */
const digestOf = (receipt: Running) =>
  NodeCrypto.createHash('sha256')
    .update(receipt.stdout)
    .update('\0')
    .update(receipt.stderr)
    .digest('hex')

/** The opening the list shows: the command's first line, cut to `COMMAND_SHOWN` characters. */
const openingOf = (command: string) => {
  const text = command.trim()
  const end = text.indexOf('\n')
  return (end === -1 ? text : text.slice(0, end)).slice(0, COMMAND_SHOWN)
}

/** Writes one change to a command and announces its Person's `feed` part with it. */
const changing = <A, E, R>(
  person: PersonId,
  write: (
    tx: Parameters<Parameters<Database['Service']['transaction']>[0]>[0],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const result = yield* write(tx)
        yield* announce(tx, [Topic.part('feed')(Topic.person(person))])
        return result
      }),
    )
  })

/** A new command, written as soon as its wake is queued. A repeated start of one handle keeps the first. */
export const recordCommand = Effect.fn('Commands.record')(function* (started: StartedCommand) {
  const now = yield* Clock.currentTimeMillis
  yield* changing(started.personId, (tx) =>
    tx
      .insert(computerCommands)
      .values({ ...started, startedAt: now, outputAt: now, outputDigest: null, unreachable: null })
      .onConflictDoNothing(),
  )
})

/**
 * A read of the receipt found the command running. It is written only when the Computer had not
 * answered before, or the output changed and the last change written is a minute old, so a
 * command that runs for hours costs one write a minute at most. A command with no row (the server
 * stopped between queueing it and `recordCommand`) gets one.
 */
export const noteRunning = Effect.fn('Commands.running')(function* (
  started: StartedCommand,
  receipt: Running,
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const digest = digestOf(receipt)
  const [row] = yield* database.run(
    database.select().from(computerCommands).where(eq(computerCommands.handle, started.handle)),
  )
  if (row === undefined)
    return yield* changing(started.personId, (tx) =>
      tx
        .insert(computerCommands)
        .values({ ...started, startedAt: now, outputAt: now, outputDigest: digest })
        .onConflictDoNothing(),
    )
  const printed =
    row.outputDigest !== digest &&
    (row.outputDigest === null || now - row.outputAt >= OUTPUT_RESOLUTION_MS)
  if (row.unreachable === null && !printed) return
  yield* changing(started.personId, (tx) =>
    tx
      .update(computerCommands)
      .set(
        printed
          ? { unreachable: null, outputAt: now, outputDigest: digest }
          : { unreachable: null },
      )
      .where(eq(computerCommands.handle, started.handle)),
  )
})

/**
 * A read of the receipt could not reach the Computer, for `reason`. Only the first failure of a run
 * of them is written, so `since` says how long the Computer has not answered.
 */
export const noteUnreachable = Effect.fn('Commands.unreachable')(function* (
  started: StartedCommand,
  reason: string,
) {
  const now = yield* Clock.currentTimeMillis
  const unreachable = yield* encodeUnreachable(CommandUnreachable.make({ since: now, reason }))
  yield* changing(started.personId, (tx) =>
    tx
      .insert(computerCommands)
      .values({ ...started, startedAt: now, outputAt: now, outputDigest: null, unreachable })
      .onConflictDoUpdate({
        target: computerCommands.handle,
        set: { unreachable },
        setWhere: isNull(computerCommands.unreachable),
      }),
  )
})

/**
 * Whether a command's final receipt wakes its Thread. A Stop from the work view is the Person (or
 * Vivid, for Stop everything) ending the work, so the Stopped receipt it caused wakes nothing, as a
 * stopped Run starts nothing. A command that ended on its own while that Stop was under way still
 * owes its Thread its result.
 */
export const owesWake = Effect.fn('Commands.owesWake')(function* (
  handle: ShellHandle,
  receipt: ShellSnapshot,
) {
  const database = yield* Database
  const [row] = yield* database.run(
    database
      .select({ stoppedAt: computerCommands.stoppedAt })
      .from(computerCommands)
      .where(eq(computerCommands.handle, handle)),
  )
  return !(ShellSnapshot.guards.Stopped(receipt) && row !== undefined && row.stoppedAt !== null)
})

/** The command has ended and its Thread has what it is owed: it leaves the list. */
export const releaseCommand = Effect.fn('Commands.release')(function* (started: StartedCommand) {
  yield* changing(started.personId, (tx) =>
    tx.delete(computerCommands).where(eq(computerCommands.handle, started.handle)),
  )
})

/**
 * Marks this Person's command as being stopped from the work view, before the Computer is told,
 * so the queue's next read of a Stopped receipt cannot wake its Thread in between. Answers whether
 * there was a listed command to mark: none means it had ended or was already being stopped.
 */
export const markStopping = Effect.fn('Commands.markStopping')(function* (
  person: PersonId,
  handle: ShellHandle,
) {
  const now = yield* Clock.currentTimeMillis
  const marked = yield* changing(person, (tx) =>
    tx
      .update(computerCommands)
      .set({ stoppedAt: now })
      .where(
        and(
          eq(computerCommands.handle, handle),
          eq(computerCommands.personId, person),
          isNull(computerCommands.stoppedAt),
        ),
      )
      .returning({ handle: computerCommands.handle }),
  )
  return marked.length > 0
})

/** A Stop that did not end the command: it is listed again and its receipt wakes its Thread. */
export const unmarkStopping = Effect.fn('Commands.unmarkStopping')(function* (
  person: PersonId,
  handle: ShellHandle,
) {
  yield* changing(person, (tx) =>
    tx
      .update(computerCommands)
      .set({ stoppedAt: null })
      .where(and(eq(computerCommands.handle, handle), eq(computerCommands.personId, person))),
  )
})

/**
 * This Actor's background commands that have not ended and are not being stopped, newest first,
 * in the workspace they are working in, each with its Thread's title. Read from the rows alone.
 */
export const runningCommands = Effect.fn('Commands.list')(function* (actor: Actor) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ command: computerCommands, title: threads.title })
      .from(computerCommands)
      .innerJoin(threads, eq(threads.id, computerCommands.threadId))
      .where(
        and(
          isNull(computerCommands.stoppedAt),
          ownedHere({ personId: computerCommands.personId, companyId: threads.companyId }, actor),
        ),
      )
      .orderBy(desc(computerCommands.startedAt), desc(computerCommands.handle)),
  )
  return yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* ({ command, title }) {
      const unreachable =
        command.unreachable === null ? null : yield* decodeUnreachable(command.unreachable)
      return BackgroundWork.cases.Command.make({
        handle: command.handle,
        thread: command.threadId,
        title,
        command: openingOf(command.command),
        startedAt: command.startedAt,
        outputAt: command.outputAt,
        unreachable,
      })
    }),
  )
})
