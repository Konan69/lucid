import {
  Appearance,
  DraftListResponse,
  MeResponse,
  NotificationListResponse,
  ProjectListResponse,
  Settings,
  ThreadListResponse,
} from '@vivid/contracts'
import { Data, Effect, Option, Predicate, Queue, Schema } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { LiveState, liveStateOf, type KeptQuery } from './live.js'
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
 * - T3 clears an environment's cache when the environment is removed. Vivid erases on sign-out,
 *   on another Person signing in, and when the server says the session is gone.
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
 * `ORCHESTRATION_CACHE_SCHEMA_VERSION` does.
 */
const VERSION = 1

/**
 * One device's snapshot. It is decoded with the same Schemas the socket uses, so text that is
 * not exactly what this build would have been sent is not a snapshot.
 *
 * Whose it is, is in it: `origin` is the server it was read from, and `me` says the Person and
 * the workspace (one source for both, not a second copy that could disagree). An answer that had
 * not arrived when the snapshot was written is absent.
 */
export const Snapshot = Schema.Struct({
  version: Schema.Literal(VERSION),
  origin: Schema.String,
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
 * as this build's format, and it was read from the server this device is talking to. Anything
 * else is none, and the caller erases it; a device's storage is input like any other.
 */
export const readSnapshot = (stored: Option.Option<string>, origin: string) =>
  Option.filter(Option.flatMap(stored, decode), (snapshot) => snapshot.origin === origin)

/**
 * The snapshot as text to store, or none for a state the format cannot say. Keeping a snapshot
 * is a convenience, so a state that will not encode is simply not written; it never stops the
 * writer.
 */
export const writeSnapshot = (snapshot: Snapshot): Option.Option<string> => encode(snapshot)

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

/** Where a device keeps its one snapshot. Each app supplies it; a store that fails holds nothing. */
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
  let answers = noAnswers
  /** Counts changes, so a flush with nothing new to write writes nothing. */
  let changed = 0
  let written = 0
  /** Tells the writer something changed. Until the writer is running, the change waits. */
  let wake = () => {}

  /** The state as it would be written now: nothing, until the server has said whose it is. */
  const latest = (): Option.Option<Snapshot> =>
    Option.map(me, (mine) => ({
      version: VERSION,
      origin,
      me: mine,
      threads: answers.threads,
      projects: answers.projects,
      settings: answers.settings,
      appearance: answers.appearance,
      notifications: answers.notifications,
      drafts: answers.drafts,
    }))

  const note = () => {
    changed += 1
    wake()
  }

  /** One write of the state as it stands, when it has changed since the last one. */
  const persist = Effect.suspend(() => {
    const at = changed
    if (at === written) return Effect.void
    return Option.match(Option.flatMap(latest(), writeSnapshot), {
      onNone: () => Effect.void,
      onSome: (text) =>
        Effect.map(store.write(text), () => {
          written = at
        }),
    })
  })

  return {
    me: () => me,
    persist,
    /** The server said who is signed in and where. */
    heardMe: (next: MeResponse) => {
      // The lists held are the workspace's the Person was in. Once they are somewhere else, a
      // snapshot made of the new `me` and the old lists would be the wrong workspace's under the
      // right name, so the lists wait until each has answered again.
      const moved = Option.exists(
        me,
        (before) =>
          before.person.id !== next.person.id ||
          workspaceKey(before.workspace) !== workspaceKey(next.workspace),
      )
      if (moved) answers = noAnswers
      me = Option.some(next)
      note()
    },
    /** One kept query answered. */
    heard: (change: (held: Answers) => Answers) => {
      answers = change(answers)
      note()
    },
    /** Nothing held is anyone's to write down any more. */
    clear: () => {
      me = Option.none()
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
      yield* keepLatest(changes, persist)
    }),
  }
}

/**
 * Keeps one device's snapshot for the life of one live engine: reads it once and seeds the kept
 * queries, judges it when the server says who is signed in, writes the server's answers down as
 * they change, and erases it when it is no longer this Person's.
 *
 * Holding every kept query's subscription open is deliberate: they are the first screen's, so
 * they are asked the moment the socket opens, not when a screen first mounts.
 */
export function makeSnapshots(input: SnapshotsInput) {
  const { registry, queries, store } = input
  const held = makeHeld(input.origin, store)
  /** The snapshot this run started from, until the server's first word has judged it. */
  let started = Option.none<Snapshot>()

  const seed = (snapshot: Option.Option<Snapshot>) => {
    registry.set(
      queries.me.seed,
      Option.map(snapshot, (kept) => kept.me),
    )
    registry.set(
      queries.threads.seed,
      Option.flatMap(snapshot, (kept) => kept.threads),
    )
    registry.set(
      queries.projects.seed,
      Option.flatMap(snapshot, (kept) => kept.projects),
    )
    registry.set(
      queries.settings.seed,
      Option.flatMap(snapshot, (kept) => kept.settings),
    )
    registry.set(
      queries.appearance.seed,
      Option.flatMap(snapshot, (kept) => kept.appearance),
    )
    registry.set(
      queries.notifications.seed,
      Option.flatMap(snapshot, (kept) => kept.notifications),
    )
    registry.set(
      queries.drafts.seed,
      Option.flatMap(snapshot, (kept) => kept.drafts),
    )
  }

  /** Takes down what the device kept, from the screen and from what would be written next. */
  const takeDown = () => {
    started = Option.none()
    held.clear()
    seed(Option.none())
  }

  /** Takes it down and erases the store, and is finished only when the store is empty. */
  const erase = Effect.suspend(() => {
    takeDown()
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
      OtherPerson: () => {
        seed(Option.none())
        input.launch(store.erase)
      },
    })
  }

  /** Reads the store once. A snapshot that cannot be used is erased, so it is not read again. */
  const restore = Effect.flatMap(store.read, (stored) => {
    const snapshot = readSnapshot(stored, input.origin)
    if (Option.isNone(snapshot)) return Option.isSome(stored) ? store.erase : Effect.void
    return Effect.sync(() => {
      started = snapshot
      seed(snapshot)
      settle()
    })
  })

  const stops = [
    registry.subscribe(
      queries.me.answers,
      (result) => {
        LiveState.$match(liveStateOf(result), {
          Loading: () => {},
          Ready: ({ value }) => {
            held.heardMe(value)
            settle()
          },
          // The server says the session is gone: what was kept is no longer anyone's to see here.
          Failed: ({ failure }) => {
            if (Predicate.isTagged(failure, 'Unauthenticated')) input.launch(erase)
          },
        })
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
    /**
     * Signing out: nothing of this Person stays on the device or on screen. It ends once the
     * store is empty, so a page can wait for it before it reloads.
     */
    erase,
    /** Ends the subscriptions and the writer, when the engine they belong to ends. */
    stop: () => {
      for (const stop of stops) stop()
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
