import {
  absorbed,
  draftIn,
  draftScopeOf,
  forgotten,
  makeDraftSync,
  readDrafts,
  withDraft,
  writeDrafts,
  type DraftScope,
  type Drafts,
} from '@vivid/state'
import type { ThreadId } from '@vivid/contracts'
import { Equivalence, Option } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { create } from 'zustand'
import { start } from './app'
import { kept } from './kept'
import { live } from './live'
import { engine } from './runtime'

/**
 * What the Person has typed and not sent: kept in this browser, and following them to their other
 * devices. A composer draws what is kept for its place and writes each change straight back, so
 * leaving a Thread, reloading the page or closing the window does not lose a half-written
 * request, and a request half-written on the phone is in this composer a moment later. The model
 * and the rules of following are shared with the phone (`@vivid/state` `drafts.ts`, `sync.ts`);
 * this is where the browser keeps them and the socket they travel on.
 *
 * Each tab is a client of its own. It holds its own copy of the drafts and its own account of
 * which keystrokes it has not saved, and signs its saves with its own name. The browser's store
 * is where the tabs' copies meet: a tab takes in what another wrote by the same rule it applies
 * to a list from the server (`absorbed`: never over keystrokes it has not saved), whenever the
 * store says it was written and before each write of its own, and each document once (`seen`).
 * Two tabs open on one Thread therefore never pull words out from under each other, and typing
 * in one Thread here does not undo a draft just written in another tab.
 *
 * A keystroke changes this tab's memory and nothing else. The store is one document holding every
 * draft, and it is synchronous: reading it decodes all of them and writing it encodes all of
 * them, on the thread the Person is typing on. That used to happen on every key (24 reads and 24
 * writes for a 24-letter sentence, `drafts.test.ts`). Now the store is written at most once per
 * `REST_MS` while words change, and at once when the page is hidden or left, which is when a
 * browser may discard it. The design is T3 Code's (`apps/web/src/lib/storage.ts`
 * `createDebouncedStorage`, flushed on unload); here the wait is not restarted by each key, so a
 * tab that dies mid-sentence has lost at most `REST_MS` of it.
 *
 * The store can also refuse a write: the drafts then live in this tab's memory for as long as it
 * is open, and sending a message is never held up by it.
 */

const KEY = 'vivid-drafts'

/**
 * The name this tab signs its saves with, so it can tell its own save coming back from a change
 * made by another client. It is a random word, made when the page loads and held only in
 * memory: not a Device (those are the Person's computers, `data/computers.ts`), not a session,
 * not the Person, and not shared with the tab beside it, which is another client
 * (`@vivid/contracts` `Draft.device`).
 */
const tab = crypto.randomUUID()

/** The document the store held when this tab opened. */
const opened = kept.read(KEY)

interface Typed {
  /** This tab's copy. A tab that opens takes over whatever the last one left owed. */
  readonly drafts: Drafts
  /**
   * Words that are only space, in the one place they were just typed. They are no draft and are
   * never kept, but the field must go on showing them: a Person who starts a message with a new
   * line would otherwise have it taken out from under the cursor. Writing anywhere lets it go.
   */
  readonly blank: Option.Option<{ readonly where: string; readonly text: string }>
}

/**
 * This tab's copy, in a Zustand store, as T3 Code web keeps its interface state
 * (`apps/web/src/uiStateStore.ts`). A field reads its own place with `draftAt`, so it is drawn
 * again only when its own words change. The browser's copy is read and written by hand below,
 * under the name and in the document it always was: the rules for when it may be written and
 * what may be taken in from another tab are this module's own, and no middleware knows them.
 */
export const useDrafts = create<Typed>()(() => ({
  drafts: readDrafts(opened),
  blank: Option.none(),
}))

/** The words in a place right now, exactly as its field should show them. */
export const draftAt = (where: string) => (state: Typed) =>
  Option.match(
    Option.filter(state.blank, (here) => here.where === where),
    { onNone: () => draftIn(state.drafts, where), onSome: (here) => here.text },
  )

/** This tab's drafts as they stand. */
const held = () => useDrafts.getState().drafts

/** How long changed drafts may wait in memory before the store is written, in milliseconds. */
const REST_MS = 300

/** The write that is waiting for `REST_MS` to pass. None when the store has what memory has. */
let resting = Option.none<ReturnType<typeof setTimeout>>()

/**
 * The store's document as this tab last knew it: the one it last took in, or the one it last put
 * there. While the store still holds exactly this, nothing in it is news, and there is nothing to
 * decode or take in. It is also what tells another tab's words from this tab's own earlier
 * write: taken for another's, an older copy of words typed here could replace the newer ones in
 * memory (`absorbed` takes an unsaved text that differs).
 *
 * A document is taken in once, against the drafts this tab held when it found it. This used to
 * be only the document this tab last wrote, so another tab's document went on reading as news
 * until this tab's next write landed, and was taken in again at each look. In between, the
 * server's answer to a save turns words here from keystrokes nothing may replace into saved
 * words, which another tab's unsaved text does replace: the second taking-in put that tab's
 * older words over the ones just saved. That was every time the other tab's document arrived
 * while a save was on its way, and always in a store that takes no write (`reopened.test.ts`).
 * The other tab still holds its words and still owes them; they come back from the server, in
 * the server's order, once it has saved them.
 *
 * It starts as the document this tab opened on, which is this tab's copy too. Started as none,
 * that document read as another tab's for as long as the store took no write from here: a
 * browser whose store is full still answers reads, so words kept from the last visit came back
 * over newer ones the moment the server had saved those (`reopened.test.ts`).
 */
let seen = opened
const sameDocument = Option.makeEquivalence(Equivalence.strictEqual<string>())

/**
 * Takes in what another tab has stored since this tab last looked, by `absorbed`'s rule: never
 * over keystrokes this tab has not saved.
 */
function takeIn() {
  const stored = kept.read(KEY)
  if (sameDocument(stored, seen)) return
  // Marked before anything else can look: whether or not a write of this tab's follows.
  seen = stored
  useDrafts.setState({ drafts: absorbed(held(), readDrafts(stored)) })
}

/** Writes this tab's drafts to the store now, after taking in what other tabs put there. */
function store() {
  Option.map(resting, clearTimeout)
  resting = Option.none()
  takeIn()
  // A store that refuses is not said: this tab's memory has the words either way. It then still
  // holds the document just taken in, which `seen` already names.
  Option.map(writeDrafts(held()), (text) => {
    if (kept.write(KEY, text)) seen = Option.some(text)
  })
}

/** Owes the store a write, `REST_MS` from the first change it has not had. */
function rest() {
  if (Option.isSome(resting)) return
  resting = Option.some(setTimeout(store, REST_MS))
}

/** The Thread ids of one answer from the Thread list, made once for that answer. */
const listed = new WeakMap<object, ReadonlySet<ThreadId>>()

/**
 * Who is signed in and where they are working, once the server has said. It is the server's own
 * answer, never what this browser kept from its last visit (`data/snapshot.ts`): a workspace or
 * a list from then is not what the server holds now, and nothing is sent, and no list applied,
 * on the word of a copy.
 */
const scope = (): Option.Option<DraftScope> => {
  const me = engine.registry.get(live.me.answers)
  return AsyncResult.isSuccess(me) ? Option.some(draftScopeOf(me.value)) : Option.none()
}

const sync = makeDraftSync({
  device: tab,
  read: () => Option.some(held()),
  update: (change) => put(change(held())),
  scope,
  threads: () => {
    const threads = engine.registry.get(live.threads.answers)
    if (!AsyncResult.isSuccess(threads)) return Option.none()
    // `sync.changed` asks on every keystroke, and the list is the same answer between two of
    // the server's; a set of every Thread's id is not built again for each letter.
    const known = listed.get(threads.value)
    if (known !== undefined) return Option.some(known)
    const ids = new Set(threads.value.threads.map((thread) => thread.id))
    listed.set(threads.value, ids)
    return Option.some(ids)
  },
  save: (request) => engine.change((client) => client.SaveDraft(request)),
  launch: start,
})

/**
 * Replaces this tab's drafts: in memory and on screen at once, in what is owed, and in the store
 * once they have rested (`rest`).
 */
function put(next: Drafts) {
  useDrafts.setState({ drafts: next })
  rest()
  sync.changed()
}

// Another tab wrote the store. What it wrote is taken in by the same rule as a list from the
// server, so it never replaces what is being typed here, and nothing is written back: this tab
// has nothing new to say, and writing would only make the other tab hear its own words again.
window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return
  takeIn()
})

// A page that is hidden or left may never run again: a phone's browser discards a tab in the
// background, and closing the window ends it. What was typed in the last `REST_MS` is stored
// before that, so it is there when the Person comes back.
const storeIfOwed = () => {
  if (Option.isSome(resting)) store()
}
window.addEventListener('pagehide', storeIfOwed)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) storeIfOwed()
})

// Who is signed in, and where, is what says which of this browser's drafts are theirs to send;
// the Thread list is what gives words an earlier build kept their place.
engine.registry.subscribe(live.me.answers, () => sync.changed())
engine.registry.subscribe(live.threads.answers, () => sync.changed())

// What the server holds for this Person here, each time it changes and each time the socket
// comes back. Held open for the life of the page, so a draft from another device is already in
// its place when the Person opens that Thread.
engine.registry.subscribe(
  live.drafts.answers,
  (result) => {
    if (AsyncResult.isSuccess(result)) sync.heard(result.value)
  },
  { immediate: true },
)

/**
 * The session ended (`data/ending.ts`): every save on its way is called off, and everything the
 * server has a copy of leaves this browser. Words typed here that it never took stay, named for
 * their Person, because they are nowhere else.
 */
export const forgetDrafts = () => {
  sync.stop()
  takeIn()
  useDrafts.setState({ drafts: forgotten(held()) })
  // At once, not after a rest: what the session held must not outlast it in the store.
  store()
}

export const draft = {
  /** The words in a place right now, for code that is not a component (`draftAt` for one that is). */
  in: (where: string) => draftAt(where)(useDrafts.getState()),
  /** Keeps a place's words as they now stand; words that are only space remove its draft. */
  keep: (where: string, text: string) => {
    useDrafts.setState({
      blank:
        text.length > 0 && text.trim().length === 0 ? Option.some({ where, text }) : Option.none(),
    })
    put(withDraft(held(), where, text, Date.now()))
  },
  /**
   * Takes a place's words to send them: answers them, trimmed, and empties the place in the same
   * step. Words that are only space are nothing to send and are left as they are.
   *
   * A composer used to send the words its last render had drawn. Three presses of Enter handled
   * before React drew the emptied field each read those same words and sent them as three
   * messages under three keys (reproduced in a browser on 10 October 2026). The words are read
   * here, from the one copy, at the press: the first press takes them and the others find none.
   */
  take: (where: string): string => {
    const words = draft.in(where).trim()
    if (words.length > 0) draft.keep(where, '')
    return words
  },
}
