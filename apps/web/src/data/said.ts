import { Effect, Option, Result } from 'effect'
import { create } from 'zustand'

/**
 * Things the app has to tell the Person that have no place of their own on screen.
 *
 * Most refusals are said where they happened: under the field, in the dialog. A quick action has
 * no such place. Renaming a Thread in the sidebar, stopping Vivid, removing a Connection: each
 * shows its result at once and is taken back if the server refuses, and a title that silently
 * jumps back, or a Stop that seems to do nothing, reads as the app not working. Those say one
 * sentence here, at the foot of the window, for a few seconds.
 *
 * The sentences on show are `useSaid`, a Zustand store, as T3 Code web keeps its interface state
 * (`apps/web/src/rightPanelStore.ts`).
 */

export interface Saying {
  readonly id: number
  readonly words: string
  /** The caller's identity for deduplicating this sentence, when it has one. */
  readonly key: Option.Option<string>
  /** Where the sentence leads, when it leads somewhere: "Open" on something that finished. */
  readonly action: Option.Option<{ readonly label: string; readonly go: () => void }>
  /** On its way out: still drawn, for the moment it takes to leave the way it came. */
  readonly leaving: boolean
}

/** Long enough to read one sentence twice; short enough not to sit over the composer. */
const SAID_FOR_MS = 6000

/**
 * How long a sentence stays in the document after it is sent away, so it can be seen to go. It
 * is a little over the exit it covers (`--dur-exit`, 150 ms in `styles/motion.css`): the timer
 * must not take the sentence out before its last frame.
 */
const LEAVING_FOR_MS = 180

export const useSaid = create<{ readonly sayings: ReadonlyArray<Saying> }>()(() => ({
  sayings: [],
}))
/** How many sentences have been said, which numbers the next one. */
let count = 0

const set = (sayings: ReadonlyArray<Saying>) => useSaid.setState({ sayings })
const all = () => useSaid.getState().sayings

/** The same sentence, on its way out. */
const sentAway = ({ id, words, key, action }: Saying): Saying => ({
  id,
  words,
  key,
  action,
  leaving: true,
})

export const said = {
  /**
   * Sends a sentence away. It is marked as leaving at once, which is what the Person sees
   * answer their click, and taken out when it has gone. Dismissed twice, it still goes once.
   */
  dismiss: (id: number) => {
    const sayings = all()
    if (!sayings.some((saying) => saying.id === id && !saying.leaving)) return
    set(sayings.map((saying) => (saying.id === id ? sentAway(saying) : saying)))
    setTimeout(() => set(all().filter((saying) => saying.id !== id)), LEAVING_FOR_MS)
  },
  /**
   * Sends away the sentence a caller said under this key, when it is still showing. A sentence
   * about something the Person can no longer see must not stay on screen: a notice names its
   * Thread and offers to open it, and when access to that Thread is taken away the server stops
   * sending the notice, so what was already said about it goes too.
   */
  withdraw: (key: string) => {
    for (const saying of all()) {
      if (Option.isSome(saying.key) && saying.key.value === key) said.dismiss(saying.id)
    }
  },
}

/** Says one sentence, with somewhere to go from it; a caller key deduplicates the same event. */
export function sayWith(words: string, action: Saying['action'], key?: string) {
  const identity = Option.fromNullishOr(key)
  if (
    Option.isSome(identity) &&
    all().some((saying) => Option.isSome(saying.key) && saying.key.value === identity.value)
  ) {
    return
  }
  count += 1
  const id = count
  // The newest three are kept: more than that is a wall, and the oldest was the first read.
  set([...all(), { id, words, action, key: identity, leaving: false }].slice(-3))
  setTimeout(() => said.dismiss(id), SAID_FOR_MS)
}

/** Says one sentence. */
export const say = (words: string) => sayWith(words, Option.none())

/**
 * Follows a change whose refusal has nowhere on screen to be said, and says it. The result is
 * handed on, so a caller that also needs it can still have it. This describes the following; the
 * handler that owns the press starts it (`act` in `app.ts`).
 */
export const orSay = <Value, Failure>(
  made: Effect.Effect<Result.Result<Value, Failure>>,
  words: string,
) =>
  Effect.gen(function* () {
    const result = yield* made
    if (Result.isFailure(result)) say(words)
    return result
  })
