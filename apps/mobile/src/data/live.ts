import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  type Appearance,
  type LibraryFolderId,
  type LibraryShelf,
  type MeResponse,
  type Settings,
  type ThreadId,
} from '@vivid/contracts'
import {
  draftScopeOf,
  following,
  Following,
  LiveState,
  liveStateOf,
  makeLink,
  makeLive,
  makeSeenThread,
  makeSnapshots,
  remembering,
  workspaceKey,
  type KeptQueries,
  type LiveQuery,
  type LiveResult,
  type ProductFailure,
  type Settle,
} from '@vivid/state'
import { Data, Effect, Equal, Layer, Option, Predicate, Result, Stream } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { createContext, useContext } from 'react'
import { followThemeAtom, themeAtom } from './appearance'
import { makeDeviceDecisions } from './devices'
import { makeHandoffCalls } from './handing'
import { makeNaming } from './name'
import { makeNotifying } from './notifying'
import { makeConnecting } from './connecting'
import { makeSending } from './sending'
import { door } from './door'
import { sessionExpiry } from './account'
import { followDrafts, forgetDrafts } from './drafts'
import { forgetAppearance, vividAtom } from './vivid'
import { inFront, reconnected } from './foreground'
import { liveAddress } from './server'
import { dropAtom, sessionAtom } from './held'
import { Session, type Outside, type SignedIn } from './session'
import { bearerSocket } from './socket'
import { launch, start } from './app'
import { forgetHeard, hearIn } from './hearing'
import { forgetPlaces } from './placed'
import { snapshotStore } from './snapshot'

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
 * What a session keeps on the phone and carries to the Person's other devices, for as long as
 * the session lasts: the first screen's last answers, and what is typed and not sent. Answers
 * with the way to stop both.
 */
function keepOnDevice(
  engine: ReturnType<typeof makeLive>,
  session: SignedIn,
  queries: KeptQueries,
) {
  // The first screen's answers are written down as they change and are read back now, so this
  // session starts from what the phone last knew (`@vivid/state` `snapshot.ts`).
  const snapshots = makeSnapshots({
    registry: engine.registry,
    queries,
    store: snapshotStore,
    origin: session.server,
    expiry: sessionExpiry(session),
    now: () => Date.now(),
    launch,
  })
  // An app in the background can be ended without a word, so what has changed since the last
  // paced write is written the moment it leaves the front.
  const unflush = door.subscribe(inFront, (front) => {
    if (!front) launch(snapshots.flush)
  })
  // What is typed on this phone follows the Person to their other devices, and what they typed
  // there arrives here, for as long as this session has a socket (`data/drafts.ts`).
  // Both read the server's own answers, never what the phone kept from its last run: a list or
  // a workspace from then is not what the server holds now, and acting on it would clear or
  // overwrite a draft on the strength of old news.
  const unfollow = followDrafts({
    scope: () => {
      const me = engine.registry.get(queries.me.answers)
      return AsyncResult.isSuccess(me) ? Option.some(draftScopeOf(me.value)) : Option.none()
    },
    threads: () => {
      const threads = engine.registry.get(queries.threads.answers)
      return AsyncResult.isSuccess(threads)
        ? Option.some(new Set(threads.value.threads.map((thread) => thread.id)))
        : Option.none()
    },
    save: (request) => engine.change((client) => client.SaveDraft(request)),
    listen: (hear) =>
      engine.registry.subscribe(
        queries.drafts.answers,
        (result) => {
          if (AsyncResult.isSuccess(result)) hear(result.value)
        },
        { immediate: true },
      ),
    moved: (hear) => {
      const stops = [
        engine.registry.subscribe(queries.me.answers, hear),
        engine.registry.subscribe(queries.threads.answers, hear),
      ]
      return () => {
        for (const stop of stops) stop()
      }
    },
  })
  return {
    /** The engine is being disposed: stop listening and writing. Nothing is erased. */
    stop: () => {
      unflush()
      snapshots.stop()
      unfollow()
    },
    /**
     * The session ended, whatever ended it (`sessionEnded` below): what it was allowed to see
     * leaves the phone. The snapshot comes off the screen and out of the file, no write of it
     * can follow, saves of drafts on their way are called off, and every draft the server has a
     * copy of is forgotten.
     */
    ended: Effect.suspend(() => {
      unflush()
      unfollow()
      return snapshots.ended
    }).pipe(
      // The drafts are device atoms, and this is started from inside the session atom's own
      // change (`dispose`): they are written on a turn of their own, as `dropAtom` is.
      Effect.andThen(Effect.yieldNow),
      Effect.andThen(Effect.sync(forgetDrafts)),
      // Where the Person was is theirs too (`data/placed.ts`), and is a device atom like the drafts.
      Effect.andThen(forgetPlaces),
      // And so is what they were last told in their Threads (`data/hearing.ts`).
      Effect.andThen(forgetHeard),
    ),
  }
}

/**
 * Builds a session's reading of the catalog of services, for the Integrations page: what is
 * typed into its search, and the part of the catalog that answers to it.
 *
 * Ported from the web (`serviceSearch`, `catalogFor` and `services` in
 * `apps/web/src/data/live.ts`). There they are the page's own; here they are made per session,
 * on the session's engine, like every query the phone has.
 */
function makeCatalog(engine: ReturnType<typeof makeLive>) {
  /**
   * What the Person has typed into the catalog search. Empty asks for the most-used services.
   * Nothing typed by one Person is still there for the next: it goes with the session.
   */
  const serviceSearch = Atom.make('')

  /**
   * The part of the catalog that matches what is typed. The catalog is thousands of services
   * nobody owns, so it is searched on the server and never held here; see `ServiceCatalog` for
   * why it can be `Unavailable` while every Connection still lists. It is asked once for each
   * question: the server answers when its copy of the catalog is ready, waiting for its first
   * download after a start (`apps/server/src/connections/catalog.ts` `retainCatalog`).
   */
  const services = engine.ask(serviceSearch, (client, asked) =>
    client.FindServices({ query: asked }),
  )

  return { serviceSearch, services }
}

/**
 * Keeps this device's own atoms for how things look current with the session's answers, for the
 * life of the session: Vivid's name and face, and the Person's theme.
 */
function followLook(
  engine: ReturnType<typeof makeLive>,
  live: { readonly appearance: LiveQuery<Appearance>; readonly settings: LiveQuery<Settings> },
) {
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
}

/**
 * Builds the live data of one session: one socket, opened as the signed-in Person, and a query
 * for every `Watch…` call the app draws from.
 */
function makeLiveData(session: SignedIn) {
  // A new session starts from Vivid as it ships; its own appearance arrives with the socket.
  forgetAppearance()
  // Whether the phone can reach the server; Home says so when it cannot. Each time the socket
  // opens again after a loss, every open conversation catches up (`reconnected`).
  const link = makeLink()
  link.reopened(reconnected)
  const engine = makeLive(
    VividRpcClient.layerLive({ url: liveAddress(session.server), onLink: link.heard }).pipe(
      Layer.provide(bearerSocket(session.token)),
    ),
  )
  /**
   * Every Thread the server has refused this Person as not found, in this session: deleted, or
   * no longer theirs to see. A Thread joins it when its own live query says so, which happens
   * when its screen is opened; the Notifications screen reads it to say a row is unavailable.
   */
  const gone = Atom.keepAlive(Atom.make<ReadonlySet<ThreadId>>(new Set<ThreadId>()))
  const one = engine.query
  /** A query the first screen needs: its last answer is kept on the phone (`data/snapshot.ts`). */
  const kept = engine.kept
  const family = engine.family

  const me = kept((client) => client.WatchMe())
  const live = {
    me,
    settings: kept((client) => client.WatchSettings()),
    /** What Vivid is called and how its face is drawn where the Person is working. */
    appearance: kept((client) => client.WatchAppearance()),
    people: one((client) => client.WatchPeople()),
    threads: kept((client) => client.WatchThreads()),
    thread: family(
      (id: ThreadId) => id,
      (client, id) =>
        client.WatchThread({ id }).pipe(
          // The server's own word that this Thread is not there for this Person. It is what a
          // row elsewhere may go on to say (`gone`); nothing is inferred from a list.
          Stream.tapError((failure) =>
            Effect.sync(() => {
              if (!Predicate.isTagged(failure, 'NotFound')) return
              engine.registry.set(gone, new Set([...engine.registry.get(gone), id]))
            }),
          ),
        ),
    ),
    /** Every Thread's conversation (`conversations`, `@vivid/state`), kept on the phone as it speaks (`hearIn`). */
    conversation: followConversations(engine, session, me),
    projects: kept((client) => client.WatchProjects()),
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
    /** What Vivid may do without asking: the Person's own rules and their Company's. */
    rules: one((client) => client.WatchRules()),
    /** The record of what was done, and by whom, newest first. */
    audit: one((client) => client.WatchAudit()),
    /** What finished or needs the Person while they were elsewhere, newest first. */
    notifications: kept((client) => client.WatchNotifications()),
    /** What Vivid knows how to do: the procedures it ships with and the ones it was taught. */
    /** Where the Person's Computer stands: off, starting, running and who has the keyboard. */
    computer: one((client) => client.WatchComputer()),
    suggestions: one((client) => client.WatchSuggestions()),
    /** The Person's own computers, each with its access and whether its desktop app is listening. */
    devices: one((client) => client.WatchDevices()),
    /** Vivid's own work, grouped into what needs the Person, what is going and what is handled. */
    feed: one((client) => client.WatchFeed()),
    /** Who owes the Person what, which Vivid keeps and chases (`screen/Feed.tsx`). */
    owed: one((client) => client.WatchOwed()),
    /** The Person's own to-do list, which Vivid adds to and ticks off (`screen/Feed.tsx`). */
    todos: one((client) => client.WatchTodos()),
    /** What the Person has typed and not sent, on any device, where they are working. */
    drafts: kept((client) => client.WatchDrafts()),
  }

  const catalog = makeCatalog(engine)
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

  const onDevice = keepOnDevice(engine, session, {
    me: live.me,
    threads: live.threads,
    projects: live.projects,
    settings: live.settings,
    appearance: live.appearance,
    notifications: live.notifications,
    drafts: live.drafts,
  })

  /** Whether this Person has something typed in a Thread's composer. The composer sets it. */
  const typingIn = Atom.family((_id: ThreadId) => Atom.make(false))

  /**
   * "I am here" for one Thread, held for as long as something holds this atom and the app is in
   * front. The Thread's screen holds it only while it is the screen on top (`Present` in
   * `screen/Chat.tsx`): a screen left mounted under another is not someone looking.
   *
   * The server shows who holds it at the top of a shared Thread, and does not notify someone
   * about what they are looking at. It is one call kept open, not something said on a timer: the
   * server hears the phone leave when the call closes, when the socket closes, or when the socket
   * goes quiet because the app was suspended or lost its network
   * (`apps/server/src/rpc/link.ts`). An app in the background holds nothing, so its Person is
   * told about what they are not looking at.
   */
  const presentIn = Atom.family((id: ThreadId) =>
    engine.hold(
      Atom.make((get) => ({ typing: get(typingIn(id)), looking: get(inFront) })),
      (client, now) =>
        now.looking ? client.BePresent({ threadId: id, typing: now.typing }) : Stream.never,
    ),
  )

  // Looking at a Thread marks it read (`@vivid/state` `seen.ts`, shared with the browser). The
  // screen reads this only while it is the one on top and the app is in front
  // (`screen/Chat.tsx`), and the Thread's own query the rest of the time.
  const seenThread = makeSeenThread({ engine, threads: live.thread, me: live.me, launch })

  // Connecting an Integration is one machine for the session, made here because this is where
  // the session's registry and socket are made: every screen, sheet and card of the session
  // presses and draws from it, and an attempt outlives whichever of them began it.
  const connecting = makeConnecting({ engine, connections: live.connections.atom })

  followLook(engine, live)

  // A token the server no longer accepts (expired, revoked from another device, or left over from
  // a build that had no accounts) cannot be made to work by waiting. The device signs out, which
  // puts the sign-in screen in front of the Person, saying so, with their server still chosen. It
  // is dropped, not adopted: a dead token must leave the app even if the store cannot be written.
  // It is heard on whichever call the server refuses, not only the one that asks who is signed
  // in (`whenSessionGone`), and dropping the session is what ends it (`dispose`).
  engine.whenSessionGone(() => {
    // On the next turn, not in this one: dropping the session disposes this very registry,
    // and it is in the middle of telling its listeners about this result.
    queueMicrotask(() => door.set(dropAtom, Session.Expired({ server: session.server })))
  })

  return {
    session,
    /**
     * The session ended. This is the phone's one path for it, because every way a session ends
     * here is the session atom changing (signing out, the server refusing the token on any call,
     * a different server or Person), and that is the only thing that disposes this. An app that
     * is merely closed runs nothing, so its snapshot is there at the next launch.
     *
     * What the session was allowed to see leaves the phone (`keepOnDevice` `ended`), then every
     * subscription and the socket go.
     */
    dispose: () => {
      launch(onDevice.ended)
      onDevice.stop()
      connecting.stop()
      engine.registry.dispose()
    },
    registry: engine.registry,
    live,
    /** `run`, described and not yet started: the step a flow yields (`running` on the web). */
    running: engine.run,
    /** `change`, described and not yet started (`changing` on the web). */
    changing: engine.change,
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
    ...catalog,
    /** Connecting an Integration: the session's one machine (`data/connecting.ts`). */
    connecting,
    devices: makeDeviceDecisions(engine),
    /** A step's calls, like a device decision, outlive the banner that pressed them. */
    handing: makeHandoffCalls(engine),
    /** The Person changing their own name in Settings (`data/name.ts`). */
    naming: makeNaming(engine, live.me),
    /**
     * What Vivid remembers about the Person, read from their cell. There is no watch on it: the
     * Memory screen begins a new reading each time it is opened (`screen/settings/Memory.tsx`).
     */
    memory: remembering.make(engine),
    /**
     * Sending in a Thread: one machine for each Thread of the session (`data/sending.ts`), made
     * here for the reason `connecting` is: a delivery on its way outlives the screen that sent it.
     */
    sending: makeSending(engine),
    notifying: makeNotifying(engine), // Notifications while the app is closed.
    gone,
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
        if (!Session.$is('SignedIn')(value)) {
          // Nobody is signed in: signed out, expired, or never. The session's own ending erased
          // what it kept (`dispose`); this is for an app that was closed before that landed.
          // Where they were goes with it (`data/placed.ts`), a turn later: it is a device atom, and
          // this is inside the session atom's own change.
          launch(
            snapshotStore.erase.pipe(
              Effect.andThen(Effect.yieldNow),
              Effect.andThen(forgetPlaces),
              Effect.andThen(forgetHeard),
            ),
          )
          return Entry.Door({ session: value })
        }
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

/** What a query that has not been asked holds: nothing yet, for as long as it is not asked. */
const UNASKED: Atom.Atom<LiveResult<never>> = Atom.make(AsyncResult.initial(true))

/**
 * Reads a live query only once it can be answered, and is `Loading` until then. A Thread started
 * on this phone is drawn before the server has it (`data/first.ts`), and a query for something
 * that is not there ends for good and is never asked again; so it is not asked until it is.
 */
export function useLiveWhen<Value>(asked: boolean, query: LiveQuery<Value>): LiveState<Value> {
  const waiting: Atom.Atom<LiveResult<Value>> = UNASKED
  return liveStateOf(useAtomValue(asked ? query.atom : waiting))
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

function followConversations(
  engine: ReturnType<typeof makeLive>,
  session: SignedIn,
  me: LiveQuery<MeResponse>,
) {
  const keep = (thread: ThreadId, heard: Following) => {
    const signedIn = engine.registry.get(me.atom)
    if (!Following.$is('Live')(heard) || !AsyncResult.isSuccess(signedIn)) return
    hearIn({ origin: session.server, person: signedIn.value.person.id }, thread, heard.state)
  }
  return engine.followed<ThreadId, Following>(
    (id) => id,
    (client, threadId, last, ready) =>
      following(() => client.WatchConversation({ threadId }), last, ready).pipe(
        Stream.tap((heard) => Effect.sync(() => keep(threadId, heard))),
      ),
  )
}
