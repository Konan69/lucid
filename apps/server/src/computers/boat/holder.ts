import { Effect } from 'effect'
import {
  MachineHeld,
  MachineOperationFailed,
  MachinePersistenceFailed,
  type MachineKey,
} from '../machine.ts'
import type { Bindings } from './bindings.ts'
import type { ProviderId } from './protocol.ts'
import type { Identity } from './state.ts'
import type { Transport } from './transport.ts'

/**
 * A machine is one account's, and the machine itself says whose.
 *
 * The binding table already allows one account for a machine, but a table belongs to one server.
 * Two servers, each with its own table, could both bind the same existing machine (through
 * `VIVID_BOAT_MACHINE`, or a row written by hand), and neither could see the other: on 5 October
 * 2026 a test account on a developer's stack and a Person's account in production held one
 * machine, sharing its desktop, files and signed-in browser.
 *
 * So the holder is recorded where both servers must look: in a file on the machine's own disk,
 * `~/.vivid/holder`. Its one line is the machine's id and the binding's intent, the identifier a
 * binding is created with and keeps for life. The record is made and checked in the same command
 * that opens the desktop at every wake (`wake`), which costs no extra request, and once more by a
 * process that meets a machine already running that it did not wake itself (`admission`): before
 * a command, a desktop or browser step, the screen or a stop. So no server uses a running machine
 * without passing it, a server with an old row included:
 *
 * - no record: this binding becomes the holder. The file is created with `noclobber`, which is an
 *   exclusive create, so two servers waking the machine at once cannot both win.
 * - this binding's record: go on.
 * - this machine's id with another intent: the machine is someone else's. The command stops with
 *   `HELD` before anything is opened.
 * - another machine's id: the disk came from a template or a copy of that machine, and the record
 *   is that machine's. It says nothing about this one and is replaced.
 *
 * The disk is kept across archive and resume, so the record lasts as long as the machine. Giving
 * a machine to another account is an operator's act: remove the file on the machine and the old
 * binding in the table that holds it.
 *
 * What this does not do:
 *
 * - An archived machine cannot be asked, so a server the machine then refuses has already woken
 *   it. It leaves the machine running, because it cannot know the holder is not using it; Boat's
 *   own archive timer puts it away.
 * - A machine between states takes no command, so a stop sent to one is not checked.
 * - A copy of the holder's database is the holder: the record names a binding, and a copied
 *   table has the same binding.
 */

/** The exit status of a wake the machine refused; outside the launcher's own statuses. */
export const HELD = 73

/**
 * A binding's intent is a UUID this server made (`bindings.ts`, `intend`). It is written into a
 * shell command, so anything else is refused here: a row that did not come from this code must
 * not become shell text.
 */
const INTENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Whether an intent may be named on a machine. */
export const holdable = (intent: string): boolean => INTENT.test(intent)

/**
 * The shell that makes this binding the machine's holder, or stops with `HELD`. Both values are
 * checked before they reach here (`ProviderId` by its schema, the intent by `holdable`), and each
 * is made only of characters that mean nothing inside single quotes.
 */
export const holderClaim = (input: { readonly id: ProviderId; readonly intent: string }): string =>
  [
    `mine='${input.id} ${input.intent}'`,
    'directory="${HOME:?}/.vivid"; record="$directory/holder"',
    'mkdir -p "$directory" || exit 74',
    // An exclusive create: it does nothing when a record is already there.
    '( set -C; printf \'%s\\n\' "$mine" > "$record" ) 2>/dev/null',
    'held="$(cat "$record" 2>/dev/null)"',
    'case "$held" in',
    '  "$mine") ;;',
    `  '${input.id} '*) exit ${HELD} ;;`,
    // Another machine's record, or none that can be read: it is not about this machine.
    '  *) printf \'%s\\n\' "$mine" > "$record.new" && mv -f "$record.new" "$record" || exit 74 ;;',
    'esac',
  ].join('\n')

/** One wake: the holder is settled first, and only its own desktop is then opened. */
export const wakeCommand = (input: { readonly id: ProviderId; readonly intent: string }): string =>
  `${holderClaim(input)}\n/opt/vivid/python/bin/python3 /opt/vivid/computer/desktop.py start`

/** One command that settles the holder before anything else is done on the machine. */
export interface HolderStep {
  /** The name a failure of this command carries in `MachineOperationFailed`. */
  readonly operation: string
  readonly command: typeof holderClaim
}

/** A process meeting a running machine it did not wake: the holder is settled, nothing more. */
export const admission: HolderStep = { operation: 'holder', command: holderClaim }

/** A wake: the holder is settled and the desktop opened, in one command. */
export const wake: HolderStep = { operation: 'desktop-launcher', command: wakeCommand }

/**
 * The server's side of the record, for one process. `forget` drops what the adapter cached about
 * a machine it turns out not to hold.
 */
export const holding = (api: Transport, saved: Bindings, forget: (key: MachineKey) => void) => {
  /** The binding each machine has accepted from this process, by its intent. */
  const admitted = new Map<MachineKey, string>()
  /**
   * Send a running machine one command that first settles whose machine it is; a binding it does
   * not name is refused before anything else in the command runs. A refused binding is given up
   * here, so this server's table does not go on saying the account holds a machine that says
   * otherwise, and keeps nothing it could later stop or use the machine with.
   */
  const settle = Effect.fn('Machine.boat.holder')(function* (
    key: MachineKey,
    identity: Identity,
    step: HolderStep,
  ) {
    const intent = identity.binding.intent
    if (!holdable(intent)) return yield* Effect.fail(new MachinePersistenceFailed())
    const receipt = yield* api.command(
      identity.id,
      key,
      step.command({ id: identity.id, intent }),
      30,
    )
    if (receipt.exitCode === HELD) {
      admitted.delete(key)
      yield* saved.release(key, intent)
      forget(key)
      return yield* Effect.fail(new MachineHeld())
    }
    if (receipt.exitCode !== 0 || receipt.timedOut)
      return yield* Effect.fail(new MachineOperationFailed({ operation: step.operation }))
    admitted.set(key, intent)
    return identity
  })
  /**
   * Every use of a running machine passes here. A process that woke the machine has its answer
   * already; one that finds it running (after a restart, or with a row no wake made) asks once.
   * The answer is kept for the life of the process: the record changes only by an operator's
   * hand, and every wake asks again.
   */
  const admit = (key: MachineKey, identity: Identity) =>
    admitted.get(key) === identity.binding.intent
      ? Effect.succeed(identity)
      : settle(key, identity, admission)
  return { settle, admit }
}
