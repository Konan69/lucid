import type { DraftListResponse, DraftSaved, SaveDraftRequest, ThreadId } from '@vivid/contracts'
import {
  forgotten,
  makeDraftSync,
  readDrafts,
  writeDrafts,
  type DraftScope,
  type Drafts,
  type ProductFailure,
} from '@vivid/state'
import { Effect, Option, Stream, type Result } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { randomUUID } from 'expo-crypto'
import { launch } from './app'
import { door, useDoor } from './door'
import { keep, keepFile, recall, recallFile } from './storage'
import { answered, draftsOf, keeping, revising, unread, wordsIn, type Writing } from './writing'

/**
 * What the Person has typed and not sent, kept on this phone. A composer shows what was left in
 * its place and writes each change straight back, so leaving a Thread, or the app being closed
 * under a half-written request, does not lose it. The model of a draft is shared with the web
 * (`@vivid/state`); this is only where the phone keeps them.
 *
 * The browser reads its store in one synchronous line. A phone's store answers a moment after
 * launch, so what is typed before then is held on its own and laid over what the store kept at
 * the moment it answers (`writing.ts`). Something typed before the store has answered is therefore
 * never lost to it and never loses what the store held, and from then on there is one set of
 * drafts, no larger than what the device keeps.
 *
 * They are device atoms (`door.ts`), not a session's: drafts outlive signing out, and each place
 * is named for its Person (`draftPlace`), so nobody is shown another Person's words.
 *
 * They also follow the Person to their other devices. That part belongs to a session, because it
 * needs a socket and someone signed in: `followDrafts` is started by the session's live data and
 * stopped with it, and applies the shared rules (`@vivid/state` `drafts.ts`, `sync.ts`) to the
 * one set of drafts held here.
 */

// A file, not the protected store: drafts can run to pages (see `keepFile`).
const FILE = 'drafts.json'

/** What has been typed during this run, and whether the store has been read yet. */
const writing = Atom.keepAlive(Atom.make<Writing>(unread))

/**
 * What this device kept from its last run. A store that cannot be read holds no drafts.
 *
 * Reading it is also what lays this run's writing over it, in the same step and before the answer
 * is handed on: whatever waits for the answer to start writing drafts down (`writtenDown`) then
 * always sees the two already together, never this run's words alone.
 */
const remembered = Effect.fn('Drafts.remembered')(function* () {
  const stored = yield* recallFile(FILE).pipe(
    // Nothing can be restored from a store that will not open, which is what a first launch is.
    Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  )
  const kept = readDrafts(stored)
  yield* Effect.sync(() => door.set(writing, answered(door.get(writing), kept, Date.now())))
  return kept
})

const recalled = Atom.keepAlive(Atom.make(remembered()))

/** The drafts as the store should hold them: what is written down whenever it changes. */
const draftsAtom = Atom.keepAlive(Atom.make((get) => draftsOf(get(writing))))

/** The words in one place right now, exactly as its field holds them. */
const wordsAt = Atom.family((where: string) => Atom.make((get) => wordsIn(get(writing), where)))

/**
 * One write of the whole set. A write the store refuses is not said: the words are still held for
 * this run and the next change writes the whole set again, and a notice on every keystroke would
 * be worse than the loss it reports.
 */
const writeDown = (text: string) =>
  keepFile(FILE, text).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void))

/**
 * Every write the store needs, given what it held and the drafts as they change.
 *
 * What the store already holds goes first and is dropped, so a run in which nothing was typed
 * writes nothing, and one typed in before the store answered writes at once. There is one write
 * at a time: while one is on its way only the newest state waits behind it, so a fast typist costs
 * the store two writes, not one per letter, and an older state can never land after a newer one.
 */
const writes = (kept: Drafts, drafts: Stream.Stream<Option.Option<Drafts>>) =>
  Stream.concat(
    Stream.succeed(kept),
    // Until the store has answered there are no drafts to give it (`draftsOf`).
    drafts.pipe(
      Stream.filter(Option.isSome),
      Stream.map((read) => read.value),
    ),
  ).pipe(
    Stream.map(writeDrafts),
    Stream.changes,
    Stream.drop(1),
    Stream.buffer({ capacity: 1, strategy: 'sliding' }),
    Stream.mapEffect(writeDown),
  )

/**
 * Writes the drafts down each time they change, for as long as something holds this atom. Nothing
 * is written until the store has been read, or the first keystroke of a run would replace
 * everything the device had kept with that one draft.
 */
const writtenDown = Atom.make((get) =>
  Stream.unwrap(Effect.map(get.result(recalled), (kept) => writes(kept, get.stream(draftsAtom)))),
)

// Held for the life of the app, like the device's other subscriptions (`appearance.ts`): the store
// is read at launch, before any screen asks, and every change is written whichever screen made it.
door.mount(writtenDown)

const INSTALLATION = 'vivid-installation'

/**
 * The name this installation signs its saves with, made once and kept, so it can tell its own
 * save coming back from a change made on another device. It is a random word and nothing more:
 * not a Device, not a session, not the Person. A store that will not keep it gives this run a
 * name of its own, which costs nothing but an echo being read as news once.
 */
const named = Effect.fn('Drafts.named')(function* () {
  const kept = yield* recall(INSTALLATION).pipe(
    Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  )
  if (Option.isSome(kept)) return kept.value
  const made = randomUUID()
  yield* keep(INSTALLATION, made).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void))
  return made
})

const installation = Atom.keepAlive(Atom.make(named()))

/** What a session supplies for its drafts to follow the Person: who, where, and the socket. */
export interface Following {
  /** Who is signed in and where they are working, once the server itself has said. */
  readonly scope: () => Option.Option<DraftScope>
  /** The Threads of where the Person is, once their list has answered. */
  readonly threads: () => Option.Option<ReadonlySet<ThreadId>>
  /** One `SaveDraft` call on the session's socket, its refusal in the value. */
  readonly save: (
    request: SaveDraftRequest,
  ) => Effect.Effect<Result.Result<DraftSaved, ProductFailure>>
  /** Subscribes to what the server holds (`WatchDrafts`); answers with the way to stop. */
  readonly listen: (hear: (list: DraftListResponse) => void) => () => void
  /** Subscribes to who is signed in, where, and their Thread list changing; answers with the way to stop. */
  readonly moved: (hear: () => void) => () => void
}

/**
 * Makes this phone's drafts follow the Person for the length of one session, and answers with
 * the way to stop. It starts once the installation's name has been read, which is a moment after
 * launch; what the server says before then is said again when it is asked.
 */
export function followDrafts(session: Following): () => void {
  const stops: Array<() => void> = []
  let started = false
  const begin = (device: string) => {
    if (started) return
    started = true
    const sync = makeDraftSync({
      device,
      read: () => door.get(draftsAtom),
      update: (change) => door.set(writing, revising(door.get(writing), change)),
      scope: session.scope,
      threads: session.threads,
      save: session.save,
      launch,
    })
    stops.push(
      sync.stop,
      // Typing, an answer written back, and the store answering all arrive here.
      door.subscribe(draftsAtom, sync.changed),
      session.moved(sync.changed),
      session.listen(sync.heard),
    )
  }
  stops.push(
    door.subscribe(
      installation,
      (result) => {
        if (AsyncResult.isSuccess(result)) begin(result.value)
      },
      { immediate: true },
    ),
  )
  return () => {
    for (const stop of stops) stop()
  }
}

/**
 * The session ended: everything the server has a copy of leaves this phone. Words typed here
 * that it never took stay, named for their Person, because they are nowhere else.
 */
export const forgetDrafts = () => door.set(writing, revising(door.get(writing), forgotten))

export const draft = {
  /** The words left in a place right now, for code that runs after a screen has waited. */
  in: (where: string): string => door.get(wordsAt(where)),
  /** Keeps a place's words as they now stand; words that are only space remove its draft. */
  keep: (where: string, text: string) =>
    door.set(writing, keeping(door.get(writing), where, text, Date.now())),
}

/**
 * The words in a place, for its composer. The composer draws this value and holds no copy, so what
 * is on screen is what is kept, and a draft the store hands over just after the screen appeared is
 * shown without anything copying it into state.
 */
export const useDraft = (where: string): string => useDoor(wordsAt(where))
