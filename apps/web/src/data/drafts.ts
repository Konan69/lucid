import {
  draftIn,
  makeDraftSync,
  readDrafts,
  withDraft,
  workspaceKey,
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
 * Two things can go wrong with a browser's store, and neither may cost the Person their words.
 * Another tab has its own copy: each change is therefore made to what the store holds now, not to
 * this tab's earlier reading of it, so typing in one Thread here does not undo a draft just
 * written in another tab. And the store can refuse a write: the drafts then live in this tab's
 * memory for as long as it is open, and sending a message is never held up by it.
 */

const KEY = 'vivid-drafts'
const INSTALLATION = 'vivid-installation'

/**
 * The name this browser signs its saves with, made once and kept, so it can tell its own save
 * coming back from a change made on another device. It is a random word and nothing more: not a
 * Device (those are the Person's computers, `data/computers.ts`), not a session, not the Person.
 * Every tab of this browser shares it, as they share the one store. A browser that will not keep
 * it gets a name for the life of the tab.
 */
const installation = Option.getOrElse(kept.read(INSTALLATION), () => {
  const made = crypto.randomUUID()
  kept.write(INSTALLATION, made)
  return made
})

/** This tab's copy: what the store held when last read, plus anything it would not take. */
let drafts = readDrafts(kept.read(KEY))
/** Whether the store is taking writes. Once it refuses, this tab's memory is the truth. */
let durable = true
/**
 * Words that are only space, in the one place they were just typed. They are no draft and are
 * never kept, but the field must go on showing them: a Person who starts a message with a new
 * line would otherwise have it taken out from under the cursor. Writing anywhere lets it go.
 */
let blank = Option.none<{ readonly where: string; readonly text: string }>()

const listeners = new Set<() => void>()

/** The drafts as they stand: the store's, while it is being written to, else this tab's own. */
const latest = () => (durable ? readDrafts(kept.read(KEY)) : drafts)

/** Who is signed in and where they are working, once the server has said. */
const scope = (): Option.Option<DraftScope> => {
  const me = engine.registry.get(live.me.atom)
  return AsyncResult.isSuccess(me)
    ? Option.some({ person: me.value.person.id, workspace: workspaceKey(me.value.workspace) })
    : Option.none()
}

const sync = makeDraftSync({
  device: installation,
  read: () => Option.some(drafts),
  update: (change) => put(change(latest())),
  scope,
  save: (request) => engine.change((client) => client.SaveDraft(request)),
  launch: start,
})

/** Replaces the drafts: in this tab, in the store, on screen, and in what is owed the server. */
function put(next: Drafts) {
  drafts = next
  durable = kept.write(KEY, writeDrafts(next))
  for (const listener of listeners) listener()
  sync.changed()
}

// Another tab wrote the store: this tab's composers show it, and nothing is sent for it (the tab
// that was typed in owes the save; both would send the same words under the same name).
window.addEventListener('storage', (event) => {
  if (event.key !== KEY || !durable) return
  drafts = latest()
  for (const listener of listeners) listener()
})

// Who is signed in, and where, is what says which of this browser's drafts are theirs to send.
engine.registry.subscribe(live.me.atom, () => sync.changed())

// What the server holds for this Person here, each time it changes and each time the socket
// comes back. Held open for the life of the page, so a draft from another device is already in
// its place when the Person opens that Thread.
engine.registry.subscribe(
  live.drafts.atom,
  (result) => {
    if (AsyncResult.isSuccess(result)) sync.heard(result.value.drafts)
  },
  { immediate: true },
)

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
    put(withDraft(latest(), where, text, Date.now()))
  },
  /** Told when any place's words change, here or because another device's draft arrived. */
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
