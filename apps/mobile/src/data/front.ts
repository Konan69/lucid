import type { ThreadId } from '@vivid/contracts'
import { Data, Option } from 'effect'

/**
 * What the first screen is showing: somewhere to start a new Thread, or one Thread.
 *
 * A Thread used to be a screen of its own, pushed over Home, so a first message ended with a
 * second screen sliding in over the one it was typed on. Now there is one place and this says what
 * is in it: sending a first message, or choosing a Thread anywhere in the app, changes what the
 * place shows and moves nothing. The web does the same in its main pane (`apps/web/src/App.tsx`,
 * `Place`): `New` and `Thread` are two readings of one pane, never two pages.
 *
 * - `Fresh`: Vivid's greeting and the composer; nothing has been said yet.
 * - `Thread`: that Thread's conversation. `writing` says the Person got here by sending from the
 *   keyboard, so the Thread's composer takes the keyboard over and it never goes down between
 *   the two.
 *
 * It is not a route parameter because it is not somewhere to go back from: the system's way back
 * belongs to the screens pushed over this one.
 */
export type Front = Data.TaggedEnum<{
  Fresh: {}
  Thread: { readonly id: ThreadId; readonly writing: boolean }
}>
export const Front = Data.taggedEnum<Front>()

// One object for the standing that carries nothing, as an external store must hand out.
const FRESH = Front.Fresh()

/**
 * What the first screen shows, for one workspace. The shell makes one each time it is built
 * (`Shell` in `App.tsx`, keyed by workspace), so a Thread of one Company is never still in front
 * after the Person has moved to another.
 */
export function makeFront() {
  let showing: Front = FRESH
  // The empty Thread a first message's failed send left behind, when there is one.
  let unsaid = Option.none<ThreadId>()
  const listeners = new Set<() => void>()

  const show = (next: Front) => {
    showing = next
    for (const listener of listeners) listener()
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** What is in front. The same object until it changes. */
    showing: () => showing,
    /** Puts a Thread in front. One that is already there stays as it is. */
    open: (id: ThreadId, writing: boolean) => {
      if (Front.$is('Thread')(showing) && showing.id === id) return
      show(Front.Thread({ id, writing }))
    },
    /**
     * The Thread a first message made and did not reach, for the next send to speak into instead
     * of making a second one. It is kept here and not by the greeting's screen, because the
     * greeting is taken down whenever a Thread is put in front, and the Person can come back to
     * it with their words still in the composer (`data/drafts.ts`).
     */
    unsaid: () => unsaid,
    /** Records, or forgets, the Thread a first message is still owed to. */
    owe: (thread: Option.Option<ThreadId>) => {
      unsaid = thread
    },
    /** Back to somewhere to start a new Thread. */
    fresh: () => {
      if (Front.$is('Fresh')(showing)) return
      show(FRESH)
    },
  }
}

export type FrontStore = ReturnType<typeof makeFront>
