import { OpenFirstThreadResult, type ThreadId } from '@vivid/contracts'
import { LiveState, liveStateOf } from '@vivid/state'
import { Data, Option, Result } from 'effect'
import type { LiveData } from './live'

/**
 * A Person's first arrival: the one time Vivid opens a Thread and speaks before they do.
 *
 * Home used to greet someone Vivid had never met and ask what to take off their plate. Vivid's
 * model never saw those words, so the Thread the Person's answer started began with Vivid
 * greeting and asking all over again. Now the server opens the first Thread and starts a Run in
 * it with no Person message (`OpenFirstThread`), so what Vivid says first is in the conversation
 * and its questions are real Input requests.
 *
 * - `Unasked`: this session has not asked the server yet.
 * - `Asking`: it has, and the answer is on its way, or the answer named a Thread and Home is
 *   still being covered by it. Home shows only Vivid's face meanwhile.
 * - `Settled`: it is over. Home is the ordinary Home from here on.
 *
 * Ported from the web's `apps/web/src/data/arrival.ts`: the same three standings, the same
 * once-only rule, the same reading of each answer (`destination`). Three things differ, each
 * because the phone does:
 * - It is one store for each session (`arrivalOf`), not one for the module. A browser page is
 *   reloaded when its session changes; an app outlives its sessions (`data/live.ts`).
 * - The web reads where the Person is from its own router. Here that is the native stack, which
 *   only a screen can reach, so Home hands itself over when it starts listening (`attend`).
 * - The web replaces Home with the Thread in its history. Here a Thread is not a screen: it is
 *   put in the first screen's own place (`data/front.ts`), so there is nothing to replace and
 *   nothing to wait for. The asking is over the moment the Thread is put there.
 */
export type Arrival = Data.TaggedEnum<{
  Unasked: {}
  Asking: {}
  Settled: {}
}>
export const Arrival = Data.taggedEnum<Arrival>()

// One object for each standing, as an external store must hand out.
const UNASKED = Arrival.Unasked()
const ASKING = Arrival.Asking()
const SETTLED = Arrival.Settled()

/** What Home draws under its top bar. */
export type Showing = Data.TaggedEnum<{
  /** Not known yet which Home this Person gets, so nothing that would be taken away again. */
  Nothing: {}
  /** Their first Thread is being opened: Vivid's face alone. */
  Waiting: {}
  /** The greeting and the composer. */
  Ordinary: {}
}>
export const Showing = Data.taggedEnum<Showing>()

/** As much of the Thread list as the first arrival reads: which Threads are in it. */
interface Listed {
  readonly threads: ReadonlyArray<{ readonly id: ThreadId }>
}

/**
 * Whether to ask the server now: only once, only when the Thread list has arrived with nothing in
 * it, and only while the Person is looking at Home. Someone who is on another screen (a Thread
 * opened from a notification) is not asked for until they come back to Home, so nothing takes
 * them away from where they went.
 */
const shouldAsk = (standing: Arrival, threads: LiveState<Listed>, onHome: boolean): boolean =>
  Arrival.$is('Unasked')(standing) &&
  onHome &&
  LiveState.$is('Ready')(threads) &&
  threads.value.threads.length === 0

/**
 * The Thread to take the Person to, when the server's answer names one they can open here.
 *
 * `Existing` is answered for the Person, not for the workspace: someone whose first Thread is in
 * their own space gets it again when they arrive in a Company that has no Threads yet, and that
 * Thread cannot be opened from there. So an existing Thread is only gone to when this
 * workspace's list has it, which happens when another device opened it a moment ago.
 */
const destination = (
  answer: OpenFirstThreadResult,
  isListed: (id: ThreadId) => boolean,
): Option.Option<ThreadId> =>
  OpenFirstThreadResult.match(answer, {
    Opened: ({ thread }) => Option.some(thread),
    Existing: ({ thread }) => (isListed(thread) ? Option.some(thread) : Option.none()),
    NotFirst: () => Option.none(),
  })

/**
 * What Home draws for where the first arrival stands and what is known of the Thread list.
 *
 * While asking it is the face whatever the list says: the new Thread reaches the list before the
 * server's answer says which Thread to show, and a greeting drawn then would flash before it.
 * Before asking, a list that has not arrived draws nothing (the greeting used to show for that
 * moment and then be taken away from a new Person), and an empty one is already waiting, because
 * it is asked about at once. A list that could not be read is no reason to keep someone from
 * typing.
 */
export const homeShows = (standing: Arrival, threads: LiveState<Listed>): Showing =>
  Arrival.$match(standing, {
    Asking: () => Showing.Waiting(),
    Settled: () => Showing.Ordinary(),
    Unasked: () =>
      LiveState.$match(threads, {
        Loading: () => Showing.Nothing(),
        Failed: () => Showing.Ordinary(),
        Ready: ({ value }) => (value.threads.length === 0 ? Showing.Waiting() : Showing.Ordinary()),
      }),
  })

/**
 * The first screen, as the first arrival needs it: whether the Person is looking at it, how to
 * put a Thread in its place, and when it comes back to the front. `screen/Home.tsx` builds it
 * from its navigator; `onFocus` answers with the way to stop listening.
 */
export interface HomeScreen {
  readonly isFocused: () => boolean
  readonly open: (thread: ThreadId) => void
  readonly onFocus: (heard: () => void) => () => void
}

/** The first arrival of one session. */
function makeArrival(data: LiveData) {
  let standing: Arrival = UNASKED
  let home = Option.none<HomeScreen>()
  const watchers = new Set<() => void>()
  const tell = () => {
    for (const watcher of watchers) watcher()
  }

  const threads = () => liveStateOf(data.registry.get(data.live.threads.atom))

  /** Whether the Thread list, as it stands right now, has this Thread in it. */
  const isListed = (id: ThreadId) => {
    const now = threads()
    return LiveState.$is('Ready')(now) && now.value.threads.some((thread) => thread.id === id)
  }

  /** Ends the asking: Home is the ordinary one from here on. */
  const finish = () => {
    standing = SETTLED
    tell()
  }

  /**
   * Acts on the server's answer. With a Thread to show, and the Person still on the first screen,
   * it is put there; one who has gone somewhere else meanwhile is left where they are. Either way
   * the asking is over: without a Thread the screen is the ordinary one and they can simply type.
   */
  const settle = (thread: Option.Option<ThreadId>) => {
    const screen = Option.filter(home, (at) => at.isFocused())
    if (Option.isSome(thread) && Option.isSome(screen)) screen.value.open(thread.value)
    finish()
  }

  /**
   * Asks the server to open the first Thread. The Thread and its Run exist before the answer
   * comes back, so the Thread's screen finds both and nothing has to be asked again.
   */
  const ask = () => {
    standing = ASKING
    tell()
    void data
      .change((client) => client.OpenFirstThread())
      .then(
        (answer) =>
          settle(Result.isFailure(answer) ? Option.none() : destination(answer.success, isListed)),
        () => settle(Option.none()),
      )
  }

  /** Asks, the first time the list is found empty while the Person is on Home. */
  const consider = () => {
    const onHome = Option.isSome(home) && home.value.isFocused()
    if (shouldAsk(standing, threads(), onHome)) ask()
  }

  return {
    /**
     * Home starts listening, and hands itself over. From here the list and Home's own focus are
     * heard, not a screen drawing: the server is asked when the list arrives empty, or when the
     * Person comes back to Home with it still empty. The answer is the way to stop.
     */
    attend: (screen: HomeScreen, watcher: () => void) => {
      home = Option.some(screen)
      watchers.add(watcher)
      const stopList = data.registry.subscribe(data.live.threads.atom, consider, {
        immediate: true,
      })
      const stopFocus = screen.onFocus(consider)
      return () => {
        stopList()
        stopFocus()
        watchers.delete(watcher)
        home = Option.none()
      }
    },
    /** Where the first arrival stands. The same object until it moves. */
    standing: () => standing,
  }
}

// One for each session's live data, and gone with it: signing out and in again is a new Person.
const arrivals = new WeakMap<LiveData, ReturnType<typeof makeArrival>>()

/** The first arrival of the session a screen is drawn in. */
export const arrivalOf = (data: LiveData) => {
  const existing = arrivals.get(data)
  if (existing !== undefined) return existing
  const made = makeArrival(data)
  arrivals.set(data, made)
  return made
}
