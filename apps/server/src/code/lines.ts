import { Option } from 'effect'
import { bytes } from './budgets.ts'

/** The lines a piece of printed text completed, and the text of the line still being printed. */
export interface Printed {
  readonly lines: ReadonlyArray<string>
  readonly rest: string
}

/**
 * Adds a piece of what a process printed to the line it left unfinished.
 *
 * A Computer's provider hands over output in pieces of whatever size it read, so a message can
 * arrive split and several can arrive together. `limit` is the longest line, in UTF-8 bytes, that
 * may be kept: `None` means a line passed it, whether it ended or is still growing, and the caller
 * stops reading. Nothing longer than the limit plus one piece is ever held.
 */
export function printed(rest: string, text: string, limit: number): Option.Option<Printed> {
  const joined = rest + text
  const end = joined.lastIndexOf('\n')
  const lines = end === -1 ? [] : joined.slice(0, end).split('\n')
  const open = end === -1 ? joined : joined.slice(end + 1)
  if (bytes(open) > limit || lines.some((line) => bytes(line) > limit)) return Option.none()
  return Option.some({ lines, rest: open })
}
