import { draftIn, readDrafts, withDraft, writeDrafts } from '@vivid/state'
import { Option } from 'effect'

/**
 * What the Person has typed and not sent, kept in this browser. A composer starts from what was
 * left in its place and writes each change straight back, so leaving a Thread, reloading the page
 * or closing the window does not lose a half-written request. The model of a draft is shared with
 * the phone (`@vivid/state`); this is only where the browser keeps them.
 */

const KEY = 'vivid-drafts'

let drafts = readDrafts(Option.fromNullOr(localStorage.getItem(KEY)))

export const draft = {
  /** The words left in a place, read when its composer appears. */
  in: (where: string) => draftIn(drafts, where),
  /** Keeps a place's words as they now stand; words that are only space remove its draft. */
  keep: (where: string, text: string) => {
    drafts = withDraft(drafts, where, text, Date.now())
    localStorage.setItem(KEY, writeDrafts(drafts))
  },
}
