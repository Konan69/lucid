import {
  Appearance,
  DraftListResponse,
  MeResponse,
  NotificationListResponse,
  ProjectListResponse,
  Settings,
  ThreadListResponse,
} from '@vivid/contracts'
import { Data, Effect, Option, Queue, Schema } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import type { KeptQuery } from './live.js'
import { workspaceKey } from './threads.js'

/**
 * What the first screen needs, kept on the device between launches.
 *
 * Nothing of a live query used to be kept, so every cold start waited for the socket before the
 * Thread list or Home could draw. A device now writes down the server's last answers and starts
 * from them: the first screen draws at once from the last known state and the server corrects it
 * a moment later.
 *
 * Ported from T3 Code, which restores a cached snapshot at launch and then follows the socket:
 * - `refs/t3code/packages/client-runtime/src/state/shell.ts` (`makeEnvironmentShellState`): load
 *   the cache into the initial state, replace it with the first live result, write only live
 *   results back, flush when the connection drops.
 * - `refs/t3code/packages/client-runtime/src/state/cachePersistence.ts` (`runCachePersistence`):
 *   the pacing of writes, kept here as `keepLatest` with the same numbers.
 * - `refs/t3code/apps/web/src/connection/storage.ts` (`cacheStore.loadShell` / `saveShell`) and
 *   `platform/orchestrationCache.ts` (`decodeOrDiscardOrchestrationCache`): the stored value is
 *   JSON text decoded with a Schema that pins a version and names whose it is; one that does not
 *   decode, or is someone else's, is discarded and never shown.
 *
 * What Vivid changes, and why:
 * - T3 keys a snapshot by an environment id it knows before connecting. A Vivid device does not
 *   know who is signed in until `WatchMe` answers (the browser's session is a cookie it cannot
 *   read; the phone holds a token, not a Person). So the snapshot carries `me`, the device starts
 *   from the one snapshot it holds, and the first live `WatchMe` judges it (`judge`): another
 *   Person's is erased, another workspace's is taken down.
 * - T3 keeps one reducer state per environment; Vivid keeps an Atom per live query, so a snapshot
 *   is a seed for each kept query (`KeptQuery`) and each is replaced by its own first answer.
 * - T3 clears an environment's cache when the environment is removed. Vivid erases when the
 *   session ends, by one path whatever ended it (`makeSnapshots` `ended`), when another Person
 *   signs in, and at launch when the session it was written under has expired.
 * - T3 keeps whole snapshots. Vivid bounds each list and the whole (`LIMITS`).
 *
 * What is kept, and why each is safe to leave on a device. All of it is what the signed-in Person
 * was already shown on this device, and none of it is a credential:
 * - `me` (`WatchMe`): the Person's name, email and picture, and the Companies they belong to.
 * - `threads` (`WatchThreads`): Thread titles, previews and who started them.
 * - `projects` (`WatchProjects`): Project names and counts.
 * - `settings` (`WatchSettings`): theme, time zone, whether to notify.
 * - `appearance` (`WatchAppearance`): what Vivid is called and how its face is drawn.
 * - `notifications` (`WatchNotifications`): titles and bodies of what the bell lists.
 * - `drafts` (`WatchDrafts`): the Person's own unsent words, which the device keeps already.
 *
 * Never kept: the session or any token; an Integration's fields (`WatchConnections`); the
 * Computer (`WatchComputer`), whose viewer address is a short-lived permission; a Thread's
 * conversation, which is Flue's and is large; anything searched.
 */

/**
 * The format's version. Changing what a kept answer holds changes this, and every device then
 * discards what it wrote under the old one (`readSnapshot`), as T3's
 * `ORCHESTRATION_CACHE_SCHEMA_VERSION` does. Version 2 records when the session ends.
 */
const VERSION = 2

/**
 * One device's snapshot. It is decoded with the same Schemas the socket uses, so text that is
 * not exactly what this build would have been sent is not a snapshot.
 *
 * Whose it is, is in it: `origin` is the server it was read from, and `me` says the Person and
 * the workspace (one source for both, not a second copy that could disagree). `expiresAt` is
 * when the session it was written under ends, in epoch milliseconds, as the server told this
 * client: a snapshot does not outlive the session that was allowed to see what is in it. An
 * answer that had not arrived when the snapshot was written, or was too long to keep whole
 * (`LIMITS`), is absent.
 */
export const Snapshot = Schema.Struct({
  version: Schema.Literal(VERSION),
  origin: Schema.String,
  expiresAt: Schema.Finite,
  me: MeResponse,
  threads: Schema.OptionFromOptionalKey(ThreadListResponse),
  projects: Schema.OptionFromOptionalKey(ProjectListResponse),
  settings: Schema.OptionFromOptionalKey(Settings),
  appearance: Schema.OptionFromOptionalKey(Appearance),
  notifications: Schema.OptionFromOptionalKey(NotificationListResponse),
  drafts: Schema.OptionFromOptionalKey(DraftListResponse),
})
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

const SnapshotJson = Schema.fromJsonString(Snapshot)
const decode = Schema.decodeUnknownOption(SnapshotJson)
const encode = Schema.encodeOption(SnapshotJson)

/**
 * The snapshot a store's text stands for, when it is one this device may start from: it decodes
 * as this build's format, it was read from the server this device is talking to, and the session
 * it was written under has not ended by this device's clock. Anything else is none, and the
 * caller erases it, undrawn; a device's storage is input like any other. A snapshot with no
 * recorded expiry does not decode, so it is erased like the rest.
 */
export const readSnapshot = (stored: Option.Option<string>, origin: string, now: number) =>
  Option.filter(
    Option.flatMap(stored, decode),
    (snapshot) => snapshot.origin === origin && snapshot.expiresAt > now,
  )

/**
 * How much of each list is kept, and of everything together.
 *
 * A snapshot is for the first screen, which draws the top of each list, so each is bounded by
 * what that screen can show and the whole by a size that is read and decoded at launch without
 * being felt. A list longer than its bound is not kept at all: a cut list would be drawn as the
 * whole list, with a Thread missing and nothing to say so, and the server's answer arrives a
 * moment later either way. `total` is the length of the encoded text in UTF-16 units, which is
 * what both stores hold; a Person's fifty drafts can each run to pages, and are what it is for.
 */
export const LIMITS = { threads: 200, projects: 200, notifications: 100, total: 400_000 } as const

/** A list, when it is short enough to keep whole. */
const within = <Value>(
  kept: Option.Option<Value>,
  length: (value: Value) => number,
  limit: number,
): Option.Option<Value> => Option.filter(kept, (value) => length(value) <= limit)

/**
 * The snapshot as text to store, or none when it should not be stored: a state the format
 * cannot say, or one too large to keep (`LIMITS`). Keeping a snapshot is a convenience, so
 * neither stops the writer; the caller erases what the store held, which is now older than
 * what it could not write.
 */
export const writeSnapshot = (snapshot: Snapshot): Option.Option<string> =>
  Option.filter(
    encode({
      version: snapshot.version,
      origin: snapshot.origin,
      expiresAt: snapshot.expiresAt,
      me: snapshot.me,
      threads: within(snapshot.threads, (list) => list.threads.length, LIMITS.threads),
      projects: within(snapshot.projects, (list) => list.projects.length, LIMITS.projects),
      settings: snapshot.settings,
      appearance: snapshot.appearance,
      notifications: within(
        snapshot.notifications,
        (list) => list.notifications.length,
        LIMITS.notifications,
      ),
      drafts: snapshot.drafts,
    }),
    (text) => text.length <= LIMITS.total,
  )

/**
 * What the server's first word on who is signed in makes of the snapshot a device started from.
 * - `Same`: the same Person in the same workspace. What is on screen stands until each query's
 *   own answer replaces it.
 * - `OtherWorkspace`: the same Person, now working somewhere else (they switched on another
 *   device). The kept lists are that other workspace's and are taken down; nothing is erased,
 *   because the next write replaces it.
 * - `OtherPerson`: someone else is signed in. Nothing kept is theirs to see: it is taken down
 *   and erased.
 */
export type Verdict = Data.TaggedEnum<{
  Same: {}
  OtherWorkspace: {}
  OtherPerson: {}
}>
export const Verdict = Data.taggedEnum<Verdict>()

export const judge = (snapshot: Snapshot, me: MeResponse): Verdict => {
  if (snapshot.me.person.id !== me.person.id) return Verdict.OtherPerson()
  return workspaceKey(snapshot.me.workspace) === workspaceKey(me.workspace)
    ? Verdict.Same()
    : Verdict.OtherWorkspace()
}

/**
 * Writes the latest state down, paced so that keeping it never competes with drawing it.
 *
 * Ported from T3 Code's `runCachePersistence`
 * (`refs/t3code/packages/client-runtime/src/state/cachePersistence.ts`) with its numbers: the
 * first write comes half a second after the first change, so the burst of answers that follows
 * the socket opening is one write; after that there is at most one write every ten seconds,
 * however often a list moves. `changes` is a sliding queue of one, so any number of changes
 * while a write cools down is one pending change, and `persist` reads the state as it is when it
 * runs, never a copy made when the change was offered. T3's own note stands: do not debounce
 * upstream of this, or an older state can be held back while a newer one waits.
 */
export const keepLatest = Effect.fn('Snapshot.keepLatest')(function* (
  changes: Queue.Dequeue<void>,
  persist: Effect.Effect<void>,
) {
  yield* Queue.take(changes)
  yield* Effect.sleep('500 millis')
  yield* Queue.poll(changes)
  while (true) {
    yield* persist
    yield* Effect.sleep('10 seconds')
    yield* Queue.take(changes)
  }
})

/**
 * Where a device keeps its one snapshot. Each app supplies it. A store that fails holds nothing
 * and says nothing: each of these ends without a failure whatever the platform did, and a store
 * that has failed once may refuse everything after it (the browser's does, `apps/web`).
 */
export interface SnapshotStore {
  readonly read: Effect.Effect<Option.Option<string>>
  readonly write: (text: string) => Effect.Effect<void>
  readonly erase: Effect.Effect<void>
}

/** The live queries whose last answers are kept. Each app builds them with `engine.kept`. */
export interface KeptQueries {
  readonly me: KeptQuery<MeResponse>
  readonly threads: KeptQuery<ThreadListResponse>
  readonly projects: KeptQuery<ProjectListResponse>
  readonly settings: KeptQuery<Settings>
  readonly appearance: KeptQuery<Appearance>
  readonly notifications: KeptQuery<typeof NotificationListResponse.Type>
  readonly drafts: KeptQuery<DraftListResponse>
}

/** The server's answers since it last said who is signed in and where: a snapshot without `me`. */
interface Answers {
  readonly threads: Option.Option<ThreadListResponse>
  readonly projects: Option.Option<ProjectListResponse>
  readonly settings: Option.Option<Settings>
  readonly appearance: Option.Option<Appearance>
  readonly notifications: Option.Option<typeof NotificationListResponse.Type>
  readonly drafts: Option.Option<DraftListResponse>
}

const noAnswers: Answers = {
  threads: Option.none(),
  projects: Option.none(),
  settings: Option.none(),
  appearance: Option.none(),
  notifications: Option.none(),
  drafts: Option.none(),
}

export interface SnapshotsInput {
  readonly registry: AtomRegistry.AtomRegistry
  readonly queries: KeptQueries
  readonly store: SnapshotStore
  /** The server this device is talking to: the page's origin, or the phone's chosen server. */
  readonly origin: string
  /**
   * When the session this client holds ends, in epoch milliseconds, as the server says; none
   * when it cannot be learned. Asked once the server has confirmed who is signed in. Nothing is
   * written without it.
   */
  readonly expiry: Effect.Effect<Option.Option<number>>
  /** This device's clock, in epoch milliseconds. */
  readonly now: () => number
  /** Starts a program on the app's runtime and hands back the way to stop it. */
  readonly launch: (program: Effect.Effect<void>) => () => void
}

/**
 * What the server has said since this run began, and whether it has been written down. It is the
 * one mutable thing behind `makeSnapshots`, kept apart so the wiring there reads as wiring.
 */
function makeHeld(origin: string, store: SnapshotStore) {
  /** Who the server says is signed in, and where. Nothing is written before it has said. */
  let me = Option.none<MeResponse>()
  /** When their session ends. Nothing is written before that is known either. */
  let expiresAt = Option.none<number>()
  let answers = noAnswers
  /** Counts changes, so a flush with nothing new to write writes nothing. */
  let changed = 0
  let written = 0
  /**
   * Counts endings. A write reads it before it starts and again when it lands: if the session
   * ended in between, what it wrote is what was just erased, and it erases it again.
   */
  let epoch = 0
  /** Set when the session ends, for good: this engine's session does not come back. */
  let ended = false
  /** Tells the writer something changed. Until the writer is running, the change waits. */
  let wake = () => {}

  /**
   * The state as it would be written now: nothing, until the server has said whose it is and
   * when their session ends.
   */
  const latest = (): Option.Option<Snapshot> =>
    Option.flatMap(me, (mine) =>
      Option.map(expiresAt, (until) => ({
        version: VERSION,
        origin,
        expiresAt: until,
        me: mine,
        threads: answers.threads,
        projects: answers.projects,
        settings: answers.settings,
        appearance: answers.appearance,
        notifications: answers.notifications,
        drafts: answers.drafts,
      })),
    )

  const note = () => {
    changed += 1
    wake()
  }

  /**
   * One write of the state as it stands, when it has changed since the last one.
   *
   * It yields before it encodes, so the encoding (the one piece of real work here) starts on a
   * turn of its own and never inside the event that asked for the write; the lists are bounded
   * (`LIMITS`), which is what bounds that work. A state that cannot be kept erases what the
   * store held, which is older than it. Nothing is written once the session has ended, and a
   * write that was already on its way when it ended is undone.
   */
  const persist = Effect.fn('Snapshot.persist')(function* () {
    const at = changed
    const during = epoch
    const snapshot = latest()
    if (ended || at === written || Option.isNone(snapshot)) return
    yield* Effect.yieldNow
    const text = writeSnapshot(snapshot.value)
    if (ended) return
    yield* Option.match(text, { onNone: () => store.erase, onSome: store.write })
    if (epoch === during) written = at
    else yield* store.erase
  })

  return {
    me: () => me,
    persist: persist(),
    /** The server said who is signed in and where. Answers whether it is someone new to this run. */
    heardMe: (next: MeResponse): boolean => {
      // The lists held are the workspace's the Person was in. Once they are somewhere else, a
      // snapshot made of the new `me` and the old lists would be the wrong workspace's under the
      // right name, so the lists wait until each has answered again.
      const moved = Option.exists(
        me,
        (before) =>
          before.person.id !== next.person.id ||
          workspaceKey(before.workspace) !== workspaceKey(next.workspace),
      )
      const someoneNew = !Option.exists(me, (before) => before.person.id === next.person.id)
      if (moved) answers = noAnswers
      if (someoneNew) expiresAt = Option.none()
      me = Option.some(next)
      note()
      return someoneNew
    },
    /** The server said when the session ends, or it could not be learned. */
    heardExpiry: (until: Option.Option<number>) => {
      expiresAt = until
      note()
    },
    /** One kept query answered. */
    heard: (change: (held: Answers) => Answers) => {
      answers = change(answers)
      note()
    },
    /** The session ended: nothing held is anyone's to write down, now or later. */
    end: () => {
      ended = true
      epoch += 1
      me = Option.none()
      expiresAt = Option.none()
      answers = noAnswers
    },
    /**
     * The writer, for as long as it is run: every change from now on wakes it, and one that
     * happened before it started is not lost.
     */
    writer: Effect.gen(function* () {
      const changes = yield* Queue.sliding<void>(1)
      wake = () => {
        Queue.offerUnsafe(changes, undefined)
      }
      if (changed !== written) wake()
      return yield* keepLatest(changes, persist())
    }),
  }
}

/** Puts a snapshot's answers under the kept queries, or takes them out from under them. */
function seeding(registry: AtomRegistry.AtomRegistry, queries: KeptQueries) {
  return (snapshot: Option.Option<Snapshot>) => {
    const from = <Value>(pick: (kept: Snapshot) => Option.Option<Value>) =>
      Option.flatMap(snapshot, pick)
    registry.set(
      queries.me.seed,
      from((kept) => Option.some(kept.me)),
    )
    registry.set(
      queries.threads.seed,
      from((kept) => kept.threads),
    )
    registry.set(
      queries.projects.seed,
      from((kept) => kept.projects),
    )
    registry.set(
      queries.settings.seed,
      from((kept) => kept.settings),
    )
    registry.set(
      queries.appearance.seed,
      from((kept) => kept.appearance),
    )
    registry.set(
      queries.notifications.seed,
      from((kept) => kept.notifications),
    )
    registry.set(
      queries.drafts.seed,
      from((kept) => kept.drafts),
    )
  }
}

/**
 * Keeps one device's snapshot for the life of one live engine: reads it once and seeds the kept
 * queries, judges it when the server says who is signed in, writes the server's answers down as
 * they change, and erases it when the session ends or it turns out to be someone else's.
 *
 * Holding every kept query's subscription open is deliberate: they are the first screen's, so
 * they are asked the moment the socket opens, not when a screen first mounts.
 *
 * What someone at a shared computer can see, and when:
 * - A browser profile, or a phone, that holds a session the server has not ended and whose
 *   recorded expiry has not passed shows that session's own snapshot at launch, exactly as it
 *   shows that session's app a moment later. Whoever can open that profile is already inside
 *   that session; the snapshot shows them nothing the app would not.
 * - One whose session was signed out here, or whose recorded expiry has passed by this device's
 *   clock, shows nothing: the snapshot was erased at sign-out, or is erased at launch undrawn.
 * - One whose session was ended elsewhere (revoked from another device) before its expiry draws
 *   the snapshot until the server's first answer, which is `Unauthenticated`: that takes it off
 *   the screen and erases it. A device with no network cannot hear that answer and goes on
 *   showing it until the expiry passes. This window is the cost of drawing before the socket
 *   opens, and is the same data the previous Person saw on this device.
 * - Another Person signing in on the same profile: the first `WatchMe` names them, and the
 *   snapshot is taken down and erased before any of their own lists arrive.
 *
 * Until that first `WatchMe`, what is drawn is only drawn. Nothing is done on its authority:
 * nothing is written to the store from it (`KeptQuery.answers` alone is written), and nothing is
 * sent to the server on behalf of the Person it names (draft saves wait for the server's own
 * word, `sync.ts`).
 */
export function makeSnapshots(input: SnapshotsInput) {
  const { registry, queries, store } = input
  const held = makeHeld(input.origin, store)
  const seed = seeding(registry, queries)
  /** The snapshot this run started from, until the server's first word has judged it. */
  let started = Option.none<Snapshot>()
  /** Whether the session has ended; a store that answers after that seeds nothing. */
  let over = false
  let stops: ReadonlyArray<() => void> = []

  /**
   * The one way a session's snapshot ends, for every reason a session does: signing out, the
   * server refusing the session on any call, another Person signing in. What was restored comes
   * off the screen, pending and future writes are called off, and the store is erased. It is
   * finished only when the store is empty, so a page can wait for it before it reloads; a write
   * that was already on its way undoes itself when it lands (`persist`).
   */
  const ended = Effect.suspend(() => {
    over = true
    started = Option.none()
    held.end()
    seed(Option.none())
    for (const stop of stops) stop()
    stops = []
    return store.erase
  })

  /**
   * Judges the snapshot this run started from against the server's word, once. It runs when the
   * store answers and when `WatchMe` does, whichever is second.
   */
  const settle = () => {
    const me = held.me()
    if (Option.isNone(started) || Option.isNone(me)) return
    const verdict = judge(started.value, me.value)
    started = Option.none()
    Verdict.$match(verdict, {
      Same: () => {},
      OtherWorkspace: () => seed(Option.none()),
      // Someone else's: off the screen and out of the store. This session goes on, and writes
      // its own once its lists arrive.
      OtherPerson: () => {
        seed(Option.none())
        input.launch(store.erase)
      },
    })
  }

  /**
   * Reads the store once. A snapshot that cannot be used (another format, another server, a
   * session that has expired) is erased without being drawn, so it is not read again.
   */
  const restore = Effect.flatMap(store.read, (stored) => {
    const snapshot = readSnapshot(stored, input.origin, input.now())
    if (Option.isNone(snapshot)) return Option.isSome(stored) ? store.erase : Effect.void
    return Effect.sync(() => {
      if (over) return
      started = snapshot
      seed(snapshot)
      settle()
    })
  })

  /** Learns when the confirmed Person's session ends, which is what lets anything be written. */
  const learnExpiry = Effect.map(input.expiry, held.heardExpiry)

  stops = [
    registry.subscribe(
      queries.me.answers,
      (result) => {
        if (!AsyncResult.isSuccess(result)) return
        if (held.heardMe(result.value)) input.launch(learnExpiry)
        settle()
      },
      { immediate: true },
    ),
    hold(registry, queries.threads, (threads) => held.heard((a) => ({ ...a, threads }))),
    hold(registry, queries.projects, (projects) => held.heard((a) => ({ ...a, projects }))),
    hold(registry, queries.settings, (settings) => held.heard((a) => ({ ...a, settings }))),
    hold(registry, queries.appearance, (appearance) => held.heard((a) => ({ ...a, appearance }))),
    hold(registry, queries.notifications, (notifications) =>
      held.heard((a) => ({ ...a, notifications })),
    ),
    hold(registry, queries.drafts, (drafts) => held.heard((a) => ({ ...a, drafts }))),
    input.launch(restore),
    input.launch(held.writer),
  ]

  return {
    /**
     * Writes now whatever has changed since the last write. For the moments a device may not get
     * another chance: the page being hidden, the app leaving the foreground. T3 flushes the same
     * way when its connection drops (`flushLiveShellSnapshot`).
     */
    flush: held.persist,
    ended,
    /** Ends the subscriptions and the writer, when the engine they belong to is disposed. */
    stop: () => {
      for (const stop of stops) stop()
      stops = []
    },
  }
}

/** Holds one kept query's subscription open and hands each of the server's answers on. */
function hold<Value>(
  registry: AtomRegistry.AtomRegistry,
  query: KeptQuery<Value>,
  put: (value: Option.Option<Value>) => void,
) {
  return registry.subscribe(
    query.answers,
    (result) => {
      if (AsyncResult.isSuccess(result)) put(Option.some(result.value))
    },
    { immediate: true },
  )
}
