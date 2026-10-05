import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import type {
  LibraryFolderId,
  LibraryShelf,
  MeResponse,
  ThreadDetail,
  ThreadId,
} from '@vivid/contracts'
import {
  LiveState,
  liveStateOf,
  makeLink,
  makeLive,
  workspaceKey,
  type LiveFamily,
  type LiveQuery,
  type LiveResult,
  type ProductFailure,
  type Settle,
} from '@vivid/state'
import { Data, Effect, Equal, Layer, Option, Predicate, Result } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { createContext, useContext } from 'react'
import { followThemeAtom, themeAtom } from './appearance'
import { door } from './door'
import { followDrafts } from './drafts'
import { forgetAppearance, vividAtom } from './vivid'
import { inFront } from './foreground'
import { liveAddress } from './server'
import { dropAtom, sessionAtom } from './held'
import { Session, type Outside, type SignedIn } from './session'
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
 * The workspace a `WatchMe` result puts the Person in, as one comparable word, or none while the
 * server has not said. One session is one Person, so the workspace alone tells two answers apart.
 */
const whereaboutsOf = (result: LiveResult<MeResponse>): Option.Option<string> =>
  AsyncResult.isSuccess(result) ? Option.some(workspaceKey(result.value.workspace)) : Option.none()

/**
 * Builds the query a Thread's screen reads while the Person is looking at it: the Thread's live
 * detail, which marks the Thread read each time it moves.
 *
 * Looking at a Thread is what marks it read, so that happens in the atom. It is an event on the
 * data, not something a component has to remember to do after it renders; when nobody is reading
 * the atom, nothing is reported. Being present is `presentIn`.
 *
 * The Thread's own query stays subscribed for minutes after its screen closes, so coming back is
 * instant. This atom does not: it stops the moment nothing reads it, or a reply that arrived after
 * the Person left would be marked read without ever being seen. For the same reason the screen
 * reads it only while it is the one on top and the app is in front (`screen/Chat.tsx`), and the
 * Thread's own query the rest of the time.
 */
function makeSeenThread(
  engine: ReturnType<typeof makeLive>,
  threads: LiveFamily<ThreadId, ThreadDetail>,
) {
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

  // One watched query for each Thread's own query, for as long as that one exists.
  const seenQueries = new WeakMap<LiveQuery<ThreadDetail>, LiveQuery<ThreadDetail>>()

  return (id: ThreadId): LiveQuery<ThreadDetail> => {
    const base = threads.get(id)
    const existing = seenQueries.get(base)
    if (existing !== undefined) return existing
    const watched: LiveQuery<ThreadDetail> = {
      expect: base.expect,
      atom: Atom.setIdleTTL(
        Atom.readable((get) => {
          const result = get(base.atom)
          markSeen(id, result)
          return result
        }),
        0,
      ),
    }
    seenQueries.set(base, watched)
    return watched
  }
}

/**
 * Builds the live data of one session: one socket, opened as the signed-in Person, and a query
 * for every `Watch…` call the app draws from.
 */
function makeLiveData(session: SignedIn) {
  // A new session starts from Vivid as it ships; its own appearance arrives with the socket.
  forgetAppearance()
  // Whether the phone can reach the server; Home says so when it cannot.
  const link = makeLink()
  const engine = makeLive(
    VividRpcClient.layerLive({ url: liveAddress(session.server), onLink: link.heard }).pipe(
      Layer.provide(bearerSocket(session.token)),
    ),
  )
  const one = engine.query
  const family = engine.family

  const live = {
    me: one((client) => client.WatchMe()),
    settings: one((client) => client.WatchSettings()),
    /** What Vivid is called and how its face is drawn where the Person is working. */
    appearance: one((client) => client.WatchAppearance()),
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
    /** The messaging apps a Person can text Vivid from, and where each stands for them. */
    channels: one((client) => client.WatchChannels()),
    memory: one((client) => client.WatchMemory()),
    /** What Vivid knows how to do: the procedures it ships with and the ones it was taught. */
    /** Where the Person's Computer stands: off, starting, running and who has the keyboard. */
    computer: one((client) => client.WatchComputer()),
    suggestions: one((client) => client.WatchSuggestions()),
    /** What the Person has typed and not sent, on any device, where they are working. */
    drafts: one((client) => client.WatchDrafts()),
  }

  // Where the Person was working when a query was last asked, for the subscription below.
  let whereabouts = Option.none<string>()

  // A query that ended because it was not the Person's to see ("people", in their own space) was
  // answered for where they were, and an ended query asks nothing more. The web asks them again
  // when the Person moves (`whereabouts` in `apps/web/src/data/live.ts`); the phone did not, so
  // People opened in a Company still said what it had said in the Person's own space. When they
  // move, every ended query is asked again; nothing else would ask it.
  engine.registry.subscribe(live.me.atom, (result) => {
    const now = whereaboutsOf(result)
    if (Equal.equals(now, whereabouts)) return
    whereabouts = now
    engine.reopen()
  })

  // What is typed on this phone follows the Person to their other devices, and what they typed
  // there arrives here, for as long as this session has a socket (`data/drafts.ts`).
  const unfollow = followDrafts({
    scope: () => {
      const me = engine.registry.get(live.me.atom)
      return AsyncResult.isSuccess(me)
        ? Option.some({ person: me.value.person.id, workspace: workspaceKey(me.value.workspace) })
        : Option.none()
    },
    save: (request) => engine.change((client) => client.SaveDraft(request)),
    listen: (hear) =>
      engine.registry.subscribe(
        live.drafts.atom,
        (result) => {
          if (AsyncResult.isSuccess(result)) hear(result.value.drafts)
        },
        { immediate: true },
      ),
    moved: (hear) => engine.registry.subscribe(live.me.atom, hear),
  })

  /** Whether this Person has something typed in a Thread's composer. The composer sets it. */
  const typingIn = Atom.family((_id: ThreadId) => Atom.make(false))

  /**
   * "I am here" for one Thread, said for as long as something holds this atom and the app is in
   * front. The Thread's screen holds it only while it is the screen on top (`Present` in
   * `screen/Chat.tsx`): a screen left mounted under another is not someone looking.
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

  const seenThread = makeSeenThread(engine, live.thread)

  // Vivid's name and look are drawn all over the app, so they are held in one device atom every
  // face and header reads (`data/vivid.ts`). This keeps it current for the life of the session:
  // the server's answer, an expected change, and the answer for a new workspace all arrive here.
  engine.registry.subscribe(
    live.appearance.atom,
    (result) => {
      if (AsyncResult.isSuccess(result)) door.set(vividAtom, result.value)
    },
    { immediate: true },
  )

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
  // puts the sign-in screen in front of the Person, saying so, with their server still chosen. It
  // is dropped, not adopted: a dead token must leave the app even if the store cannot be written.
  engine.registry.subscribe(
    live.me.atom,
    (result) => {
      const state = liveStateOf(result)
      if (LiveState.$is('Failed')(state) && Predicate.isTagged(state.failure, 'Unauthenticated')) {
        // On the next turn, not in this one: dropping the session disposes this very registry,
        // and it is in the middle of telling its listeners about this result.
        queueMicrotask(() => door.set(dropAtom, Session.Expired({ server: session.server })))
      }
    },
    { immediate: true },
  )

  return {
    session,
    /** Ends the session's live data: every subscription, the socket, and what rode on it. */
    dispose: () => {
      unfollow()
      engine.registry.dispose()
    },
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
    link: link.atom,
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
        get.addFinalizer(data.dispose)
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
