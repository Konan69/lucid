import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import type { LibraryFolderId, LibraryShelf, ThreadDetail, ThreadId } from '@vivid/contracts'
import {
  LiveState,
  liveStateOf,
  makeLive,
  type LiveQuery,
  type LiveResult,
  type ProductFailure,
  type Settle,
} from '@vivid/state'
import { Data, Effect, Layer, Option, Predicate, Result } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { createContext, useContext } from 'react'
import { followThemeAtom, themeAtom } from './appearance'
import { door } from './door'
import { inFront } from './foreground'
import { liveAddress } from './server'
import { adoptAtom, Session, sessionAtom, type Outside, type SignedIn } from './session'
import { bearerSocket } from './socket'
import { start } from './app'

/**
 * Every screen's data, live, as Effect Atoms: the phone's half of what `apps/web/src/data/live.ts`
 * is for the browser, built on the same `@vivid/state` layer and the same `Watch…` calls.
 *
 * Nothing in the app fetches. A component reads a query with `useLive`; the query is an atom over
 * one `Watch…` subscription on the session's socket, shared by everyone reading it and kept warm
 * for half a minute after the last reader leaves, so going back to a screen shows it at once. The
 * server sends a new result when it changes, including when the Person switches workspace.
 *
 * The one difference from the web is lifetime. A browser page belongs to one session and is
 * reloaded when it changes. An app outlives its sessions, so the whole layer (socket, registry,
 * every query) is built per session and disposed with it.
 */

/**
 * Builds the live data of one session: one socket, opened as the signed-in Person, and a query
 * for every `Watch…` call the app draws from.
 */
function makeLiveData(session: SignedIn) {
  const engine = makeLive(
    VividRpcClient.layerLive({ url: liveAddress(session.server) }).pipe(
      Layer.provide(bearerSocket(session.token)),
    ),
  )
  const one = engine.query
  const family = engine.family

  const live = {
    me: one((client) => client.WatchMe()),
    settings: one((client) => client.WatchSettings()),
    people: one((client) => client.WatchPeople()),
    threads: one((client) => client.WatchThreads()),
    thread: family(
      (id: ThreadId) => id,
      (client, id) => client.WatchThread({ id }),
    ),
    routines: one((client) => client.WatchRoutines()),
    projects: one((client) => client.WatchProjects()),
    library: family(
      (shelf: LibraryShelf) => shelf,
      (client, shelf) => client.WatchLibrary({ shelf }),
    ),
    /**
     * What is inside one folder. A shelf's own result lists every item on it and the folders at
     * its top; the folders inside a folder come only from asking about that folder.
     */
    folder: family(
      (query: { readonly shelf: LibraryShelf; readonly folderId: LibraryFolderId }) =>
        `${query.shelf}:${query.folderId}`,
      (client, query) => client.WatchLibrary(query),
    ),
    connections: one((client) => client.WatchConnections()),
    suggestions: one((client) => client.WatchSuggestions()),
  }

  const seen = new Map<ThreadId, number>()

  /** Tells the server a Thread was looked at as it now stands, once for each time it moves. */
  const markSeen = (id: ThreadId, result: LiveResult<ThreadDetail>) => {
    if (!AsyncResult.isSuccess(result)) return
    const moved = result.value.thread.updatedAt
    const last = seen.get(id)
    if (last !== undefined && last >= moved) return
    seen.set(id, moved)
    void start(
      engine.run(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          yield* client.MarkThreadRead({ id })
        }),
      ),
    ).then((reported) => {
      // Forgotten again if the report did not get through, so the next result tries again
      // instead of leaving read work marked unread.
      if (Result.isFailure(reported) && seen.get(id) === moved) seen.delete(id)
    })
  }

  /** Whether this Person has something typed in a Thread's composer. The composer sets it. */
  const typingIn = Atom.family((_id: ThreadId) => Atom.make(false))

  /**
   * "I am here" for one Thread, said for as long as its screen is open and the app is in front.
   *
   * The server keeps a Person present for fifteen seconds after they last said so, and decides
   * from that who is shown at the top of a shared Thread and who gets a notification instead. It
   * used to be said only when the Thread moved, so someone reading a quiet Thread, or writing a
   * long message, dropped out of it. An app in the background says nothing, so its Person is
   * told about what they are not looking at.
   */
  const presentIn = Atom.family((id: ThreadId) =>
    engine.beat(
      Atom.make((get) => ({ typing: get(typingIn(id)), looking: get(inFront) })),
      (client, now) =>
        now.looking ? client.ReportPresence({ threadId: id, typing: now.typing }) : Effect.void,
      '5 seconds',
    ),
  )

  const seenQueries = new Map<ThreadId, LiveQuery<ThreadDetail>>()

  /**
   * A Thread's live detail, for the screen that shows it. Looking at a Thread is what marks it
   * read, so that happens here, in the atom, each time the Thread moves while someone has it
   * open. It is an event on the data, not something a component has to remember to do after it
   * renders; when nobody is reading the atom, nothing is reported. Being present is `presentIn`.
   */
  const seenThread = (id: ThreadId): LiveQuery<ThreadDetail> => {
    const existing = seenQueries.get(id)
    if (existing !== undefined) return existing
    const base = live.thread.get(id)
    const watched: LiveQuery<ThreadDetail> = {
      expect: base.expect,
      atom: Atom.readable((get) => {
        const result = get(base.atom)
        markSeen(id, result)
        return result
      }),
    }
    seenQueries.set(id, watched)
    return watched
  }

  // The Person's theme is theirs on every device; when their settings arrive, this one follows.
  engine.registry.subscribe(
    live.settings.atom,
    (result) => {
      // Only a theme this device is not already showing is adopted, so an unrelated settings
      // change does not rewrite the device's store.
      if (AsyncResult.isSuccess(result) && result.value.theme !== door.get(themeAtom)) {
        door.set(followThemeAtom, result.value.theme)
      }
    },
    { immediate: true },
  )

  // A token the server no longer accepts (expired, revoked from another device, or left over from
  // a build that had no accounts) cannot be made to work by waiting. The device signs out, which
  // puts the sign-in screen in front of the Person, saying so, with their server still chosen.
  engine.registry.subscribe(
    live.me.atom,
    (result) => {
      const state = liveStateOf(result)
      if (LiveState.$is('Failed')(state) && Predicate.isTagged(state.failure, 'Unauthenticated')) {
        door.set(adoptAtom, Session.Expired({ server: session.server }))
      }
    },
    { immediate: true },
  )

  return {
    session,
    registry: engine.registry,
    live,
    /** Runs one program with the session's client, on the same socket the queries use. */
    run: <Value, Failure>(program: Effect.Effect<Value, Failure, VividRpcClient>) =>
      start(engine.run(program)),
    /**
     * Makes a change: shows it at once in every live query it touches, sends it, and takes the
     * expectation back if the server refuses. On success the server's next result confirms it.
     */
    change: <Value>(
      program: (client: VividRpcClient['Service']) => Effect.Effect<Value, ProductFailure>,
      ...expectations: ReadonlyArray<() => Settle>
    ) => start(engine.change(program, ...expectations)),
    seenThread,
    typingIn,
    presentIn,
  }
}

export type LiveData = ReturnType<typeof makeLiveData>

/**
 * What the app is showing at its root.
 *
 * - `Opening`: the device's store is still being read.
 * - `Door`: nobody is signed in; `session` says how far from signed in this device is.
 * - `In`: someone is, and this is their live data.
 */
export type Entry = Data.TaggedEnum<{
  Opening: {}
  Door: { readonly session: Outside }
  In: { readonly data: LiveData }
}>
export const Entry = Data.taggedEnum<Entry>()

/**
 * The session's live data, built when a session begins and disposed when it ends or changes.
 * Disposing the registry closes the socket and ends every subscription, so nothing the previous
 * session was shown can still be on screen or still be arriving.
 */
export const entryAtom = Atom.keepAlive(
  Atom.make((get): Entry =>
    AsyncResult.match(get(sessionAtom), {
      onInitial: () => Entry.Opening(),
      // Reading the device's store handles its own failure (`session.ts`), so only a defect
      // lands here. The device is then as it would be on a first launch: asked for its server.
      onFailure: () => Entry.Door({ session: Session.Unset() }),
      onSuccess: ({ value }) => {
        if (!Session.$is('SignedIn')(value)) return Entry.Door({ session: value })
        const data = makeLiveData(value)
        get.addFinalizer(() => data.registry.dispose())
        return Entry.In({ data })
      },
    }),
  ),
)

/**
 * `null` only above the signed-in part of the tree, where no screen that reads live data is
 * ever drawn. The session's own object is the context value, so it is as stable as the session.
 */
const LiveDataContext = createContext<LiveData | null>(null)

export const LiveDataProvider = LiveDataContext.Provider

/** The live data of the session a screen is drawn in. Every signed-in screen is inside one. */
export function useLiveData(): LiveData {
  const data = useContext(LiveDataContext)
  if (data === null) throw new Error('This screen is drawn outside a signed-in session.')
  return data
}

/** Reads a live query. The component re-renders when, and only when, the result changes. */
export function useLive<Value>(query: LiveQuery<Value>): LiveState<Value> {
  return liveStateOf(useAtomValue(query.atom))
}

/** The value of a live query when it has one, for lists that draw the same loading or empty. */
export function useLiveValue<Value>(query: LiveQuery<Value>): Option.Option<Value> {
  const state = useLive(query)
  return LiveState.$is('Ready')(state) ? Option.some(state.value) : Option.none()
}

/**
 * What a change came to, for a form: nothing to say when the server took it, or the server's own
 * sentence about why it did not.
 */
export const refusalOf = <Value, Failure extends { readonly message: string }>(
  result: Result.Result<Value, Failure>,
): Option.Option<string> =>
  Result.isFailure(result) ? Option.some(result.failure.message) : Option.none()

export { LiveState }
