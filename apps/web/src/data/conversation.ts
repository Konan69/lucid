import type { ThreadId } from '@vivid/contracts'
import { Option } from 'effect'

/**
 * Which Threads' conversations a page holds open: the one used last and a few before it.
 *
 * A Thread's conversation is a live query on the page's socket (`conversations`, `@vivid/state`):
 * a subscription that begins with the conversation whole and then says each change. Like every
 * live query it is subscribed while something reads it and for a few minutes after. That alone
 * would let a Thread the Person left ten minutes ago go, and coming back to it would draw it
 * empty for a round trip, which is what made opening a Thread slow when each visit asked for the
 * whole history again.
 *
 * So the conversations used most recently are held: the router marks one as used when a pointer
 * rests on a link to its Thread and when the Person goes there (`data/warm.ts`), which opens it
 * before its screen is drawn, and it stays open after the screen has gone until enough others
 * have been used since. Coming back shows the conversation at once and current.
 *
 * This module is only the rule for what is held. What holding one means (`open`) is the page's
 * own (`data/sending.ts`): the conversation's query and the Thread's sending are mounted in the
 * live registry, and let go of when `end` is called. A conversation a screen is reading stays
 * subscribed whatever is decided here: the screen's own reading holds it.
 */

/** One conversation as it is held: how to let it go, and how to ask again if it ended. */
export interface Held {
  /** Lets go of it. Called once, when it is no longer among those held. */
  readonly end: () => void
  /**
   * Asks for it again when it ended in a refusal. A conversation the server refused is not asked
   * about again by itself, and a Thread started here is opened before the server has made it
   * (`data/threads.ts`): held for all, the same refusal would be what every later visit found.
   */
  readonly again: () => void
}

/**
 * The held conversations of one page.
 *
 * `kept` is how many stay open besides the one used last, which always does: it is the one a
 * screen is about to read, or the one the Person just left and is likeliest to come back to.
 * `open` begins holding a Thread's conversation.
 */
export const heldConversations = (kept: number, open: (id: ThreadId) => Held) => {
  /** Held conversations, the most recently used last: a `Map` keeps the order they were set in. */
  const held = new Map<ThreadId, Held>()

  /** Lets go of the conversations used longest ago, down to the last used and `kept` more. */
  const trim = () => {
    const older = [...held].slice(0, -1)
    for (const [id, one] of older.slice(0, Math.max(0, older.length - kept))) {
      held.delete(id)
      one.end()
    }
  }

  return {
    /**
     * Marks a Thread's conversation as used: it is opened when it was not held, asked for again
     * when it had ended in a refusal, and moved to the most recently used end.
     */
    warm: (id: ThreadId): void => {
      const one = Option.match(Option.fromUndefinedOr(held.get(id)), {
        onNone: () => open(id),
        onSome: (known) => {
          known.again()
          return known
        },
      })
      held.delete(id)
      held.set(id, one)
      trim()
    },
    /** Lets go of every conversation. */
    forget: (): void => {
      for (const one of held.values()) one.end()
      held.clear()
    },
  }
}
