import type { ProviderId } from './protocol.ts'

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
 * that opens the desktop at every wake (`boat.ts`, `ensure`), so it costs no extra request and no
 * server can use a machine without passing it:
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
