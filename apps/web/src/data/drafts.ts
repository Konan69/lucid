import { draftIn, readDrafts, withDraft, writeDrafts } from '@vivid/state'
import { kept } from './kept'

/**
 * What the Person has typed and not sent, kept in this browser. A composer starts from what was
 * left in its place and writes each change straight back, so leaving a Thread, reloading the page
 * or closing the window does not lose a half-written request. The model of a draft is shared with
 * the phone (`@vivid/state`); this is only where the browser keeps them.
 *
 * Two things can go wrong with a browser's store, and neither may cost the Person their words.
 * Another tab has its own copy: each change is therefore made to what the store holds now, not to
 * this tab's earlier reading of it, so typing in one Thread here does not undo a draft just
 * written in another tab. And the store can refuse a write: the drafts then live in this tab's
 * memory for as long as it is open, and sending a message is never held up by it.
 */

const KEY = 'vivid-drafts'

/** This tab's copy: what the store held when last read, plus anything it would not take. */
let drafts = readDrafts(kept.read(KEY))
/** Whether the store is taking writes. Once it refuses, this tab's memory is the truth. */
let durable = true

/** The drafts as they stand: the store's, while it is being written to, else this tab's own. */
const latest = () => (durable ? readDrafts(kept.read(KEY)) : drafts)

export const draft = {
  /** The words left in a place, read when its composer appears. */
  in: (where: string) => draftIn(latest(), where),
  /** Keeps a place's words as they now stand; words that are only space remove its draft. */
  keep: (where: string, text: string) => {
    drafts = withDraft(latest(), where, text, Date.now())
    durable = kept.write(KEY, writeDrafts(drafts))
  },
}
