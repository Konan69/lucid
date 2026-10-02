import { Option, Schema } from 'effect'

/**
 * What a Person has typed and not sent, kept for each place they were typing.
 *
 * A composer used to hold its words in component state, so leaving a Thread to check a Project,
 * answering an Approval, reloading the page or restarting the phone threw away a half-written
 * request. Drafts are kept on the device instead, and are still there when the Person comes back.
 *
 * This module is the model and nothing else: what a set of drafts is, how one is changed, and how
 * the set is written down and read back. Each app supplies where it is stored.
 */

/** One draft: where it was being written, the words, and when they were last touched. */
const Draft = Schema.Struct({
  where: Schema.String,
  text: Schema.String,
  at: Schema.Number,
})

export const Drafts = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(Draft),
})
export interface Drafts extends Schema.Schema.Type<typeof Drafts> {}

/** How many are kept. The oldest goes first, so a device never grows a draft for every Thread. */
const KEPT = 50

export const noDrafts: Drafts = { version: 1, entries: [] }

/**
 * The name of a place a Person types: one Thread, or the composer that starts a new one in a
 * workspace.
 *
 * It includes the Person, because a browser or a phone can be signed in as someone else later and
 * one Person's unsent words are not the next one's to find. The new-Thread composer is also named
 * for its workspace: a request half-written for one Company must not be waiting in the composer
 * of another, where sending it would start the Thread there. A Thread belongs to one workspace
 * already, so its own name is enough.
 */
export const draftPlace = (
  person: string,
  spot: { readonly workspace: string; readonly thread: Option.Option<string> },
) =>
  Option.match(spot.thread, {
    onNone: () => `${person}:${spot.workspace}:new`,
    onSome: (thread) => `${person}:${thread}`,
  })

/** The words left in a place, or none. */
export const draftIn = (drafts: Drafts, where: string): string =>
  Option.match(Option.fromUndefinedOr(drafts.entries.find((draft) => draft.where === where)), {
    onNone: () => '',
    onSome: (draft) => draft.text,
  })

/**
 * The drafts with one place's words replaced. Words that are only space are no draft at all, so
 * sending a message (which empties the composer) removes its draft.
 */
export const withDraft = (drafts: Drafts, where: string, text: string, now: number): Drafts => {
  const others = drafts.entries.filter((draft) => draft.where !== where)
  return {
    version: 1,
    entries:
      text.trim().length === 0 ? others : [{ where, text, at: now }, ...others].slice(0, KEPT),
  }
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Drafts))
const encode = Schema.encodeSync(Schema.fromJsonString(Drafts))

/**
 * Reads drafts back from storage. Anything that is not a set of drafts (nothing stored yet, a
 * file cut short, a newer app's format) is no drafts: a device's storage is input like any other.
 */
export const readDrafts = (stored: Option.Option<string>): Drafts =>
  Option.getOrElse(Option.flatMap(stored, decode), () => noDrafts)

/** The drafts as text to store. */
export const writeDrafts = (drafts: Drafts): string => encode(drafts)
