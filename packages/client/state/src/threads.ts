import type { PersonSummary, Run, Thread } from '@vivid/contracts'
import { Option } from 'effect'

export type RuntimeConversation = Omit<Thread, 'id'> & { id: string }

/** Converts Message markdown into the compact preview used by Thread lists. */
export function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Chooses the first Message line as a bounded Thread title. */
export function titleFromMessage(message: string) {
  const firstLine = message.trim().split('\n', 1)[0] ?? 'New conversation'
  return firstLine.length > 46 ? `${firstLine.slice(0, 45).trimEnd()}…` : firstLine
}

/**
 * Who a turn in the conversation was from: the Person behind the Run that has that turn.
 *
 * The conversation itself never holds an identifier (the model reads everything in it), so a
 * message there says only its turn number and the speaker's name. The Thread's Runs say who that
 * was. `turn` is the attribute as written; anything that is not a delivery has none.
 */
export const speakerOfTurn = (
  runs: ReadonlyArray<Run>,
  turn: Option.Option<string>,
): Option.Option<PersonSummary> =>
  Option.flatMap(turn, (written) =>
    Option.map(
      Option.fromUndefinedOr(runs.find((run) => String(run.turn) === written)),
      (run) => run.origin.person,
    ),
  )
