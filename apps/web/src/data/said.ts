import { Result } from 'effect'

/**
 * Things the app has to tell the Person that have no place of their own on screen.
 *
 * Most refusals are said where they happened: under the field, in the dialog. A quick action has
 * no such place. Renaming a Thread in the sidebar, stopping Vivid, removing a Connection: each
 * shows its result at once and is taken back if the server refuses, and a title that silently
 * jumps back, or a Stop that seems to do nothing, reads as the app not working. Those say one
 * sentence here, at the foot of the window, for a few seconds.
 */

export interface Saying {
  readonly id: number
  readonly words: string
}

/** Long enough to read one sentence twice; short enough not to sit over the composer. */
const SAID_FOR_MS = 6000

let sayings: ReadonlyArray<Saying> = []
let count = 0
const listeners = new Set<() => void>()

const set = (next: ReadonlyArray<Saying>) => {
  sayings = next
  for (const listener of listeners) listener()
}

export const said = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  all: () => sayings,
  dismiss: (id: number) => set(sayings.filter((saying) => saying.id !== id)),
}

/** Says one sentence. The same sentence already showing is not said twice. */
export function say(words: string) {
  if (sayings.some((saying) => saying.words === words)) return
  count += 1
  const id = count
  // The newest three are kept: more than that is a wall, and the oldest was the first read.
  set([...sayings, { id, words }].slice(-3))
  setTimeout(() => said.dismiss(id), SAID_FOR_MS)
}

/**
 * Follows a change whose refusal has nowhere on screen to be said, and says it. The result is
 * handed on, so a caller that also needs it can still have it.
 */
export async function orSay<Value, Failure>(
  made: Promise<Result.Result<Value, Failure>>,
  words: string,
) {
  const result = await made
  if (Result.isFailure(result)) say(words)
  return result
}
