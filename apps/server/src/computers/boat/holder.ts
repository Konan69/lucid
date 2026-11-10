import { Clock, Effect, Ref, Schedule } from 'effect'
import {
  MachineExecutionUnknown,
  MachineHeld,
  MachineOperationFailed,
  MachinePersistenceFailed,
  MachineRequestRejected,
  MachineUnreachable,
  type MachineFailure,
  type MachineKey,
} from '../machine.ts'
import type { Bindings } from './bindings.ts'
import { providerAlphabet, providerLength, type ProviderId } from './protocol.ts'
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
 * - no record: this binding becomes the holder.
 * - this binding's record: go on.
 * - this machine's id with another intent: the machine is someone else's. The command stops with
 *   `HELD` before anything is opened.
 * - another machine's id: the disk came from a template or a copy of that machine, and the record
 *   is that machine's. It says nothing about this one and is replaced.
 * - anything else (a record that cannot be read, is empty, or is not exactly one machine id and
 *   one intent, byte for byte): the command stops with `UNSETTLED`. Damage is never read as a free machine, and
 *   never as someone else's claim either, so it costs no server its binding. An operator looks.
 *
 * The whole read, decision and write happens under a lock on the machine (`flock`, which the
 * prepared image has: util-linux), and the record is written beside itself and moved into place.
 * So two servers that reach a machine at the same instant cannot both become its holder, and no
 * reader ever sees a record half written.
 *
 * The disk is kept across archive and resume, so the record lasts as long as the machine. Giving
 * a machine to another account is an operator's act, in this order: stop the machine, remove the
 * old binding in the table that holds it, remove the file. A screen address already given out is
 * Boat's and lasts up to ten minutes (`state.ts`), and a process keeps its answer until it
 * restarts or wakes the machine again, which is why the machine is stopped and the row removed
 * first.
 *
 * What this does not do:
 *
 * - An archived machine cannot be asked, so a server the machine then refuses has already woken
 *   it. It leaves the machine running, because it cannot know the holder is not using it. Boat's
 *   own archive timer puts it away, unless the installation set no lifetime
 *   (`VIVID_BOAT_LIFETIME_SECONDS=0`): then it runs until its holder stops it.
 * - A machine between states takes no command, so a stop sent to one is not checked.
 * - A copy of the holder's database is the holder: the record names a binding, and a copied
 *   table has the same binding.
 */

/** The exit status of a command the machine refused; outside the launcher's own statuses. */
export const HELD = 73

/** The exit status when the holder could not be settled: no lock, or a record that is damage. */
export const UNSETTLED = 74

/**
 * The exit status of a wake whose holder was settled and whose desktop launcher then failed.
 *
 * The launcher only shows the application finder on the desktop (`infra/computer/desktop.py`,
 * `start`); the shell, the files and the browser driver do not need it. On 7 October 2026 Boat's
 * desktop was not ready on the production machine after a resume, the launcher failed, and the
 * whole start was recorded as failed although the machine was running and its holder settled.
 */
export const UNOPENED = 75

/** A UUID's groups of hexadecimal digits. */
const GROUPS = [8, 4, 4, 4, 12] as const

/**
 * A binding's intent is a UUID this server made (`bindings.ts`, `intend`). It is written into a
 * shell command, so anything else is refused here: a row that did not come from this code must
 * not become shell text.
 */
const INTENT = new RegExp(`^${GROUPS.map((digits) => `[0-9a-f]{${digits}}`).join('-')}$`, 'u')

/** Whether an intent may be named on a machine. */
const holdable = (intent: string): boolean => INTENT.test(intent)

/**
 * The same two shapes as shell patterns, for the machine to hold a record against. Every
 * character is spelled out: a range such as `a-f` means different things in different locales.
 */
const intentForm = GROUPS.map((digits) => '[0123456789abcdef]'.repeat(digits)).join('-')
const machineForm = `bx_${`[${providerAlphabet}]`.repeat(providerLength)}`

/** A record is one line: a machine id, a space, an intent, a line feed. This many bytes. */
const RECORD_BYTES = 'bx_'.length + providerLength + 1 + 36 + 1

/** Put this binding's record in place whole: written beside the record, then moved over it. */
const publish = `printf '%s\\n' "$mine" > "$record.new" && mv -f "$record.new" "$record" || exit ${UNSETTLED}`

/** Protects holder admission when the current lock owner cannot finish. Source: unmeasured.
 * Retained from the production ownership fix 39dba6f39; expiry returns UNSETTLED and never
 * grants a second holder or removes its binding. */
const HOLDER_LOCK_WAIT_SECONDS = 20

/**
 * The shell that makes this binding the machine's holder, or stops with `HELD`. Both values are
 * checked before they reach here (`ProviderId` by its schema, the intent by `holdable`), and each
 * is made only of characters that mean nothing inside single quotes.
 *
 * It is POSIX shell (`sh` is the least a machine has; Boat runs commands with `bash`). Descriptor
 * 9 holds the lock from `flock` until it is closed on the last line: whatever the caller runs
 * next (the desktop launcher lives for the whole session) must not inherit it. The lock file is
 * touched first because `sh` ends at once, with its own status, when `exec` cannot open a file.
 *
 * A record is believed only when it is exact: the right number of bytes, and one of the two
 * shapes. `HELD` costs the caller its binding (`settle`), so it is said only of a record that
 * names this machine and a whole, well-formed intent that is not the caller's.
 */
export const holderClaim = (input: { readonly id: ProviderId; readonly intent: string }): string =>
  [
    `mine='${input.id} ${input.intent}'`,
    `intent='${intentForm}'`,
    `machine='${machineForm}'`,
    `[ -n "\${HOME-}" ] || exit ${UNSETTLED}`,
    'directory="$HOME/.vivid"; record="$directory/holder"',
    `mkdir -p "$directory" && touch "$directory/holder.lock" || exit ${UNSETTLED}`,
    `exec 9>"$directory/holder.lock" || exit ${UNSETTLED}`,
    `flock -w ${HOLDER_LOCK_WAIT_SECONDS} 9 || exit ${UNSETTLED}`,
    'if [ -e "$record" ] || [ -L "$record" ]; then',
    `  [ "$(wc -c < "$record")" -eq ${RECORD_BYTES} ] || exit ${UNSETTLED}`,
    `  held="$(cat "$record")" || exit ${UNSETTLED}`,
    '  case "$held" in',
    '    "$mine") ;;',
    // This machine, and a whole intent that is not the caller's: it is someone else's.
    `    '${input.id} '$intent) exit ${HELD} ;;`,
    // Another machine's record: it came with a copied disk and is not about this machine.
    `    $machine' '$intent) ${publish} ;;`,
    // Anything else is damage.
    `    *) exit ${UNSETTLED} ;;`,
    '  esac',
    'else',
    `  ${publish}`,
    'fi',
    'exec 9>&-',
  ].join('\n')

/**
 * What Boat leaves out of a Computer's snapshots, as the `.boxignore` in its home directory
 * (gitignore syntax, relative to that directory; Boat's "Snapshots & Copies", "Excluding files").
 *
 * Boat captures every file each minute, counts a hard link as a full copy, and will only start a
 * machine whose captured data fits the size it runs on. Download caches are the files that grow
 * without anyone meaning them to and that every tool rebuilds, so they are kept out. Dependency
 * trees inside a project (`node_modules`) stay in: a Person's project must come back whole after
 * a stop, and Vivid stops the Computer whenever it is idle.
 *
 * This is the guard for the Computer's own use. What filled a Person's Computer on 6 October 2026
 * was not that: it was another system's build trees (5.8 million files, 117.5 GiB captured), and
 * what prevents that is that nothing but Vivid's product runs on a Person's Computer.
 */
const SNAPSHOT_RULES = [
  '# Written by Vivid. Boat leaves these out of this Computer’s snapshots: they are caches',
  '# that tools fill again by themselves. Add lines for anything else that need not be kept.',
  '.cache/',
  '.npm/',
  '.pnpm-store/',
  '.local/share/pnpm/store/',
  '.turbo/',
  '.gradle/caches/',
  '.m2/repository/',
  '.cargo/registry/',
]

/**
 * The shell that puts those rules in place on a machine that has none. A file that is already
 * there is the Person's or Vivid's own and is left alone. It never fails the command it is part
 * of: a Computer without the file still starts.
 */
export const snapshotRules = [
  `if [ -n "\${HOME-}" ] && [ ! -e "$HOME/.boxignore" ]; then`,
  `  printf '%s\\n' ${SNAPSHOT_RULES.map((line) => `'${line}'`).join(' ')} > "$HOME/.boxignore.new" &&`,
  '    mv -f "$HOME/.boxignore.new" "$HOME/.boxignore" || true',
  'fi',
].join('\n')

/** One wake: the holder is settled first, then the snapshot rules, and only then is its own
 * desktop opened. */
const wakeCommand = (input: { readonly id: ProviderId; readonly intent: string }): string =>
  `${holderClaim(input)}\n${snapshotRules}\n/opt/vivid/python/bin/python3 /opt/vivid/computer/desktop.py start || exit ${UNOPENED}`

/** One command that settles the holder before anything else is done on the machine. */
export interface HolderStep {
  /** The name a failure of this command carries in `MachineOperationFailed`. */
  readonly operation: string
  readonly command: typeof holderClaim
}

/** A process meeting a running machine it did not wake: the holder is settled, nothing more. */
const admission: HolderStep = { operation: 'holder', command: holderClaim }

/** A wake: the holder is settled and the desktop opened, in one command. */
export const wake: HolderStep = { operation: 'desktop-launcher', command: wakeCommand }

/**
 * Whether Boat failed to run a command, or could not say whether it ran.
 *
 * Boat reports a resumed machine as running before a command can reach it. Measured on the
 * production machine on 6 October 2026: the machine read `idle` from 21:20:01 UTC, while
 * `POST /commands` answered 502 `sandbox_direct_failed` until 21:20:38 and 200 from 21:20:39; each
 * refusal took six to nine seconds to come back. A machine not yet placed answered 409
 * `machine_not_running`. `transport.ts` reads every 5xx and every lost connection on a command as
 * an uncertain receipt (`MachineExecutionUnknown`), which is right for a command a Person or the
 * model wrote and wrong to stop at for the one below.
 */
const unheard = (failure: MachineFailure): boolean =>
  failure instanceof MachineExecutionUnknown ||
  (failure instanceof MachineRequestRejected && failure.status === 409)

/** How often a machine that does not answer its holder command is asked again, and how many
 * times; `UNHEARD_FOR` bounds the same wait by the clock, since one refusal takes seconds to come
 * back. The gap measured above was 37 seconds; the same numbers bound an SSH opening
 * (`ssh/links.ts`), which waits on the same machine for the same reason. */
const ASK_AGAIN_EVERY = '2 seconds'
const ASK_AGAIN_TIMES = 30
const UNHEARD_FOR = '75 seconds'

/**
 * The server's side of the record, for one process. `forget` drops what the adapter cached about
 * a machine it turns out not to hold.
 */
export const holding = (api: Transport, saved: Bindings, forget: (key: MachineKey) => void) => {
  /** The binding each machine has accepted from this process, by its intent. */
  const admitted = new Map<MachineKey, string>()
  /**
   * The holder command, sent until the machine answers it.
   *
   * It is the first command a woken machine is sent, so it is the one that meets the gap in which
   * Boat calls the machine running and cannot yet run anything on it (`unheard`). Until 6 October
   * 2026 it was sent once: the 502 became "the command receipt was lost", the start was recorded
   * as failed, and the Person's Computer stayed unusable for the rest of the day.
   *
   * Sending it again is safe because the command is Vivid's own and says the same thing every
   * time: the claim leaves the record as it is when this binding already holds the machine
   * (`holderClaim`), and the launcher opens nothing when this desktop session already has its
   * launcher (`infra/computer/desktop.py`, `start`: a marker under a lock). A command from a
   * Person or the model is still never sent twice.
   *
   * A machine that has not answered when the wait ends is an outage (`MachineUnreachable`): nothing
   * was learned about the machine, nothing is recorded against it, and the next need asks again.
   */
  const asked = Effect.fn('Machine.boat.holderCommand')(function* (
    key: MachineKey,
    id: ProviderId,
    command: string,
  ) {
    const began = yield* Clock.currentTimeMillis
    const sent = yield* Ref.make(0)
    const told = Effect.fn('Machine.boat.holderWaited')(function* (answered: boolean) {
      const tries = yield* Ref.get(sent)
      if (tries < 2 && answered) return
      yield* Effect.logWarning('Computer did not take commands when Boat called it running', {
        answered,
        tries,
        waitedMillis: (yield* Clock.currentTimeMillis) - began,
      })
    })
    return yield* Ref.update(sent, (count) => count + 1).pipe(
      Effect.andThen(api.command(id, key, command, 30)),
      Effect.retry({
        while: unheard,
        schedule: Schedule.spaced(ASK_AGAIN_EVERY),
        times: ASK_AGAIN_TIMES,
      }),
      Effect.timeoutOrElse({
        duration: UNHEARD_FOR,
        orElse: () => Effect.fail(new MachineUnreachable()),
      }),
      Effect.catchIf(unheard, () => Effect.fail(new MachineUnreachable())),
      Effect.tap(() => told(true)),
      Effect.tapError((failure) =>
        failure instanceof MachineUnreachable ? told(false) : Effect.void,
      ),
    )
  })
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
    if (!holdable(intent)) return yield* new MachinePersistenceFailed()
    // The machine is being asked again, so what it said before no longer stands: a call that
    // fails here must not leave this process still passing on an old answer.
    admitted.delete(key)
    const receipt = yield* asked(key, identity.id, step.command({ id: identity.id, intent }))
    if (receipt.exitCode === HELD) {
      yield* saved.release(key, intent)
      forget(key)
      return yield* new MachineHeld()
    }
    // Damage, or no lock: nothing was learned about whose machine it is, so the binding stays.
    if (receipt.exitCode === UNSETTLED)
      return yield* new MachineOperationFailed({ operation: 'holder' })
    // The holder is settled and only the desktop's launcher did not open: the machine is this
    // binding's and is used. It is said in the log; the next wake tries the launcher again.
    if (receipt.exitCode === UNOPENED && !receipt.timedOut)
      yield* Effect.logWarning('Computer desktop launcher did not open')
    else if (receipt.exitCode !== 0 || receipt.timedOut)
      return yield* new MachineOperationFailed({ operation: step.operation })
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
