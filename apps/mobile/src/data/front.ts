import type { ThreadId } from '@vivid/contracts'
import { Data, Option } from 'effect'
import { makeFirsts } from './first'

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
 *   the two. A Thread started from the greeting is put here the moment its first words are sent,
 *   before the server has it (`firsts`, `data/first.ts`).
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
 *
 * It starts from the Thread that was in front when the app was last open in this workspace
 * (`data/place.ts`), so a phone that ended the app, or an update that restarted it, brings the
 * Person back to their conversation and not to the greeting. `writing` is false for it: nobody
 * is typing in a Thread that is being opened again.
 */
export function makeFront(start: Option.Option<ThreadId>) {
  let showing: Front = Option.match(start, {
    onNone: () => FRESH,
    onSome: (id) => Front.Thread({ id, writing: false }),
  })
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
     * The first words of the Threads started here, and how far each has got. They are kept here
     * and not by a screen: the greeting is taken down the moment a Thread is put in front, and
     * the send goes on after it.
     */
    firsts: makeFirsts(),
    /** Back to somewhere to start a new Thread. */
    fresh: () => {
      if (Front.$is('Fresh')(showing)) return
      show(FRESH)
    },
  }
}

export type FrontStore = ReturnType<typeof makeFront>
