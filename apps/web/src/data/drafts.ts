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
import { Option } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
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
 * to a list from the server (`absorbed`: never over keystrokes it has not saved), before every
 * change of its own and whenever the store says it was written. Two tabs open on one Thread
 * therefore never pull words out from under each other, and typing in one Thread here does not
 * undo a draft just written in another tab.
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

/** This tab's copy. A tab that opens takes over whatever the last one left owed. */
let drafts = readDrafts(kept.read(KEY))
/**
 * Words that are only space, in the one place they were just typed. They are no draft and are
 * never kept, but the field must go on showing them: a Person who starts a message with a new
 * line would otherwise have it taken out from under the cursor. Writing anywhere lets it go.
 */
let blank = Option.none<{ readonly where: string; readonly text: string }>()

const listeners = new Set<() => void>()

/** This tab's copy with whatever other tabs have written since taken in (`absorbed`). */
const current = () => absorbed(drafts, readDrafts(kept.read(KEY)))

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
  read: () => Option.some(drafts),
  update: (change) => put(change(current())),
  scope,
  threads: () => {
    const threads = engine.registry.get(live.threads.answers)
    return AsyncResult.isSuccess(threads)
      ? Option.some(new Set(threads.value.threads.map((thread) => thread.id)))
      : Option.none()
  },
  save: (request) => engine.change((client) => client.SaveDraft(request)),
  launch: start,
})

/** Replaces this tab's drafts: in memory, in the store, on screen, and in what is owed. */
function put(next: Drafts) {
  drafts = next
  // A store that refuses is not said: this tab's memory has the words either way.
  kept.write(KEY, writeDrafts(next))
  for (const listener of listeners) listener()
  sync.changed()
}

// Another tab wrote the store. What it wrote is taken in by the same rule as a list from the
// server, so it never replaces what is being typed here, and nothing is written back: this tab
// has nothing new to say, and writing would only make the other tab hear its own words again.
window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return
  drafts = current()
  for (const listener of listeners) listener()
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
  drafts = forgotten(current())
  kept.write(KEY, writeDrafts(drafts))
  for (const listener of listeners) listener()
}

export const draft = {
  /** The words in a place right now, exactly as its field should show them. */
  in: (where: string) =>
    Option.match(
      Option.filter(blank, (here) => here.where === where),
      { onNone: () => draftIn(drafts, where), onSome: (here) => here.text },
    ),
  /** Keeps a place's words as they now stand; words that are only space remove its draft. */
  keep: (where: string, text: string) => {
    blank =
      text.length > 0 && text.trim().length === 0 ? Option.some({ where, text }) : Option.none()
    put(withDraft(current(), where, text, Date.now()))
  },
  /** Told when any place's words change, here or because another device's draft arrived. */
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
