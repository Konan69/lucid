import { OpenFirstThreadResult, type ThreadId, type ThreadListResponse } from '@vivid/contracts'
import type { LiveResult } from '@vivid/state'
import { Data, Option, Result } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { create } from 'zustand'
import { change, live } from './live'
import { onFirst, router } from '../router'
import { engine } from './runtime'

/**
 * A Person's first arrival: the one time Vivid opens a Thread and speaks before they do.
 *
 * The web used to draw Vivid's first words itself, on Home. Vivid's model never saw them, so when
 * the Person answered, the real Thread began with Vivid greeting and asking all over again. Now
 * the server opens the first Thread and starts a Run in it with no Person message
 * (`OpenFirstThread`), so what Vivid says first is in the conversation, and its questions are
 * real Input requests.
 *
 * - `Unasked`: this page has not asked the server yet.
 * - `Asking`: it has, and the answer is on its way. Home shows only Vivid's face meanwhile.
 * - `Settled`: the answer came, or the question failed. Home is the ordinary Home from here on.
 *
 * It is asked once for each load of the page. Signing in or out reloads the page (`runtime`), so
 * that is once for each Person; the server makes a repeat from another tab or device harmless.
 */
export type Arrival = Data.TaggedEnum<{
  Unasked: {}
  Asking: {}
  Settled: {}
}>
export const Arrival = Data.taggedEnum<Arrival>()

// One object for each standing: the store compares what a screen selected with `Object.is`.
const UNASKED = Arrival.Unasked()
const ASKING = Arrival.Asking()
const SETTLED = Arrival.Settled()

interface FirstArrival {
  /** Where the first arrival stands. The same object until it moves. */
  readonly standing: Arrival
  /** The Thread this page had the server open, which Vivid is about to speak in. */
  readonly opened: Option.Option<ThreadId>
}

/**
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`).
 * Nothing outside this module changes it: it moves when the list, the address or the server's
 * answer says so.
 */
export const useArrival = create<FirstArrival>()(() => ({
  standing: UNASKED,
  opened: Option.none(),
}))

/** Whether a Thread list has arrived and has nothing in it. */
const isEmpty = (threads: LiveResult<ThreadListResponse>) =>
  AsyncResult.isSuccess(threads) && threads.value.threads.length === 0

/** Whether the Thread list, as it stands right now, has this Thread in it. */
const isListed = (id: ThreadId) => {
  const threads = engine.registry.get(live.threads.atom)
  return AsyncResult.isSuccess(threads) && threads.value.threads.some((thread) => thread.id === id)
}

/**
 * The Thread to take the Person to, when the server's answer names one they can open here.
 *
 * `Existing` is answered for the Person, not for the workspace: someone whose first Thread is in
 * their own space gets it again when they arrive in a Company that has no Threads yet, and that
 * Thread cannot be opened from there. So an existing Thread is only gone to when this workspace's
 * list has it, which happens when another tab opened it a moment ago.
 */
const destination = (answer: OpenFirstThreadResult): Option.Option<ThreadId> =>
  OpenFirstThreadResult.match(answer, {
    Opened: ({ thread }) => Option.some(thread),
    Existing: ({ thread }) => (isListed(thread) ? Option.some(thread) : Option.none()),
    NotFirst: () => Option.none(),
  })

/**
 * Ends the asking. With a Thread to go to, Home is replaced by it in the history, so Back does
 * not return to a Home with nothing on it; a Person who has gone somewhere else meanwhile is left
 * where they are. With none, Home becomes the ordinary one and they can simply type.
 */
const settle = (thread: Option.Option<ThreadId>) => {
  // The address moves before anyone is told, so no frame of Home is drawn on the way out.
  if (Option.isSome(thread) && onFirst()) {
    void router.navigate({ to: '/t/$id', params: { id: thread.value }, replace: true })
  }
  useArrival.setState({ standing: SETTLED })
}

/**
 * Asks the server to open the first Thread. The Thread and its Run exist before the answer comes
 * back, so the Thread screen that opens next finds both and nothing has to be asked again.
 */
const ask = () => {
  useArrival.setState({ standing: ASKING })
  void change((client) => client.OpenFirstThread()).then(
    (answer) => {
      if (Result.isFailure(answer)) return settle(Option.none())
      if (OpenFirstThreadResult.guards.Opened(answer.success)) {
        useArrival.setState({ opened: Option.some(answer.success.thread) })
      }
      settle(destination(answer.success))
    },
    () => settle(Option.none()),
  )
}

/**
 * Asks, the first time the Thread list is found empty while the Person is on Home. It is heard
 * from the list and the address themselves, not from a screen drawing, so nothing depends on
 * what happens to be rendered. Someone who arrived on an invitation or a device approval is not
 * taken away from it: nothing is asked until they are on Home.
 */
const consider = () => {
  if (!Arrival.$is('Unasked')(useArrival.getState().standing)) return
  if (isEmpty(engine.registry.get(live.threads.atom)) && onFirst()) ask()
}

// The list is heard here. The address is heard by the router, which calls `arrival.consider`
// each time the Person arrives somewhere (subscribed in `src/main.tsx`): this module is imported by the route
// tree's own imports, so it must not touch the router while it is being evaluated.
engine.registry.subscribe(live.threads.atom, consider, { immediate: true })

export const arrival = {
  /** Looks again at whether to ask, now that the address has changed. */
  consider,
}

/** Whether this is the Thread this page had opened for Vivid to speak first in. */
export const openedFor = (id: ThreadId) => (state: FirstArrival) =>
  Option.contains(state.opened, id)
