import type { FlueClient } from '@flue/sdk'
import type { ThreadId } from '@vivid/contracts'
import { Effect, Option, Semaphore } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { AppState } from 'react-native'
import { launch } from './app'
import { door } from './door'
import {
  decodeHeard,
  encodeHeard,
  heardAt,
  settledOf,
  withHeard,
  type Heard,
  type Kept,
  type Whose,
} from './heard'
import { forgetFile, keepFileAside, recallFile } from './storage'

/**
 * What was last said in the Person's recent Threads (`data/heard.ts`), as this phone keeps it:
 * one file of the app's own, read once at launch and written whole a moment after a conversation
 * has said something new. It is erased with the session (`live.ts`), so nothing one Person was
 * told is drawn for the next.
 */
const FILE = 'heard.json'

/** How long new words may wait in memory before the file is written, in milliseconds. */
const REST_MS = 1000

/**
 * What the file held at launch. A file that is missing, unreadable or in a shape this build does
 * not know is nothing kept: a Thread then opens as it did before, on its outline.
 */
const recalled = Atom.keepAlive(
  Atom.make(
    recallFile(FILE).pipe(
      Effect.map(Option.flatMap(decodeHeard)),
      Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<Heard>())),
    ),
  ),
)
// Read as the app starts, beside where the Person was (`data/placed.ts`), so it has answered
// before the Thread they were in is drawn.
door.mount(recalled)

/**
 * What stands in memory since launch, over what the file held: none until a Thread speaks or the
 * session ends, then what is kept now, which after a session's end is nothing.
 */
const changed = Atom.keepAlive(Atom.make(Option.none<Option.Option<Heard>>()))

/**
 * Whether the file has answered. The shell is not drawn before it has (`App.tsx`): drawing the
 * Thread's outline first and its words a moment later is the loading screen this removes.
 */
export const heardReadAtom = Atom.make((get) => !AsyncResult.isInitial(get(recalled)))

/** Everything kept, as it stands now: nothing, until the file has answered or a Thread speaks. */
const standing = (): Option.Option<Heard> =>
  Option.getOrElse(door.get(changed), () => Option.flatten(AsyncResult.value(door.get(recalled))))

/**
 * What was last said in a Thread and which of its replies had ended, when this phone has it and
 * it is this Person's.
 */
export const heardIn = (whose: Whose, thread: ThreadId): Option.Option<Kept> =>
  heardAt(standing(), whose, thread)

/** Whether the file is behind memory and a write is already waiting for `REST_MS` to pass. */
let owed = false

/**
 * One at a time for everything that touches the file. A write is handed to the native side and
 * answered later, so without this a write begun before the session ended could land after the
 * erasing and put a Person's words back on a phone they had signed out of.
 */
const file = Semaphore.makeUnsafe(1)

/**
 * Makes the file say what memory says now, off the JavaScript thread (`keepFileAside`): it is
 * tens of kilobytes and is written while a conversation is on screen. What is kept is read when
 * the file's turn comes, not when the write was asked for, so the last one to run always leaves
 * the file as memory is: erased when nothing is kept. A store that refuses has not kept it.
 */
const write = Semaphore.withPermit(
  file,
  Effect.suspend(() => {
    owed = false
    return Option.match(Option.flatMap(standing(), encodeHeard), {
      onNone: () => forgetFile(FILE),
      onSome: (text) => keepFileAside(FILE, text),
    }).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void))
  }),
)

// A phone may end an app it is not showing without a word: what was heard in the last
// `REST_MS` is written as the app leaves the front, so it is there at the next launch.
AppState.addEventListener('change', (state) => {
  if (state !== 'active' && owed) launch(write)
})

/** Whether two lists hold the very same items. Flue makes a new object for a message that changed. */
const sameItems = <A>(one: ReadonlyArray<A>, other: ReadonlyArray<A>) =>
  one.length === other.length && one.every((item, index) => item === other[index])

/**
 * Whether two keepings say the same: the same messages, and the same submissions ended among
 * them. Either can move without the other: the Person's message stays kept while its submission
 * runs, and is the same message when that submission fails or is stopped before Vivid has said
 * a word.
 */
const sameKept = (one: Kept, other: Kept) =>
  sameItems(one.messages, other.messages) && sameItems(one.settled, other.settled)

/**
 * What was last kept for each Thread, as the conversation handed it over. A conversation speaks
 * at every word that arrives and almost none of those change what is worth keeping; comparing
 * the message objects and the ended ids themselves (`sameKept`) says so without reading a word.
 */
const last = new Map<ThreadId, Kept>()

/** Keeps what a Thread's conversation now says, in memory at once and in the file after a rest. */
const keep = (whose: Whose, thread: ThreadId, kept: Kept) => {
  // A conversation with nothing settled in it has nothing to draw sooner; what was kept stays.
  if (kept.messages.length === 0) return
  if (Option.exists(Option.fromUndefinedOr(last.get(thread)), (was) => sameKept(was, kept))) return
  last.set(thread, kept)
  const next = withHeard(standing(), whose, { thread, kept, at: Date.now() })
  door.set(changed, Option.some(Option.some(next)))
  if (owed) return
  owed = true
  launch(
    Effect.sleep(REST_MS).pipe(Effect.andThen(Effect.suspend(() => (owed ? write : Effect.void)))),
  )
}

/**
 * A Thread's conversation client whose reading is also kept. It is the real client, with
 * `observe` handing out the real observation and one more listener on it: each time the
 * conversation speaks, what it now says is kept (`keep`). The listener ends when the observation
 * is closed, which is when the hook that reads it lets go (`useFlueAgent`). Everything used is
 * Flue's public client; nothing of the hook or the SDK is reached into.
 */
export const heardThrough = (whose: Whose, thread: ThreadId, client: FlueClient): FlueClient => ({
  ...client,
  observe: (options) => {
    const observation = client.observe(options)
    const stop = observation.subscribe(() => {
      const { conversation } = observation.getSnapshot()
      if (conversation !== undefined) keep(whose, thread, settledOf(conversation))
    })
    return {
      getSnapshot: () => observation.getSnapshot(),
      subscribe: (listener) => observation.subscribe(listener),
      refresh: () => observation.refresh(),
      close: (reason) => {
        stop()
        observation.close(reason)
      },
    }
  },
})

/**
 * The session ended: what its Person was told leaves the phone. Memory is emptied at once, and
 * the file in its turn behind any write already on its way (`write`).
 */
export const forgetHeard = Effect.suspend(() => {
  last.clear()
  door.set(changed, Option.some(Option.none<Heard>()))
  return write
})
