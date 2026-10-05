import {
  DraftPlace,
  DraftSaved,
  ThreadId,
  type Draft,
  type SaveDraftRequest,
} from '@vivid/contracts'
import { Option, Schema } from 'effect'

/**
 * What a Person has typed and not sent, kept for each place they were typing, and how this
 * device's copy and the server's copy are brought together.
 *
 * A composer used to hold its words in component state, so leaving a Thread to check a Project,
 * answering an Approval, reloading the page or restarting the phone threw away a half-written
 * request. Drafts were then kept on the device, and words typed on a laptop never reached the
 * phone. Now the device still keeps its own copy, which is what makes typing instant and what
 * survives being offline, and the server keeps the copy every device converges on
 * (`@vivid/contracts` `drafts.ts`, whose rules these functions carry out).
 *
 * This module is the model and nothing else: what a set of drafts is, how typing changes it, what
 * it owes the server, and what an answer or an arriving draft does to it. Each app supplies where
 * it is stored; `sync.ts` supplies the timing.
 */

/**
 * One draft as this device holds it.
 *
 * `revision` and `savedAt` are those of the last draft this device took from the server for the
 * place (its own confirmed save, or another device's), and both are 0 while it has taken none.
 * `unsaved` says the Person has typed here since: those keystrokes are owed to the server, and
 * until they are saved nothing arriving may replace them.
 *
 * `text` is empty in exactly one case: the Person emptied a place the server may still hold words
 * for. That entry is what remembers to clear it everywhere, and it goes once the server has.
 */
const Kept = Schema.Struct({
  where: Schema.String,
  text: Schema.String,
  at: Schema.Number,
  revision: Schema.Number,
  savedAt: Schema.Number,
  unsaved: Schema.Boolean,
})
interface Kept extends Schema.Schema.Type<typeof Kept> {}

/**
 * Version 2: an entry gained what it took from the server, and a Thread's place gained its
 * workspace (`whereOf`). A version 1 store reads as no drafts, as any text this build does not
 * understand does.
 */
export const Drafts = Schema.Struct({
  version: Schema.Literal(2),
  entries: Schema.Array(Kept),
})
export interface Drafts extends Schema.Schema.Type<typeof Drafts> {}

/** How many are kept. The oldest goes first, so a device never grows a draft for every Thread. */
const KEPT = 50

export const noDrafts: Drafts = { version: 2, entries: [] }

/**
 * Whose drafts, and in which workspace. The server takes both from who is calling and a
 * `DraftPlace` carries neither, so the device, which outlives sessions and workspaces, has to
 * name them itself: one Person's unsent words are not the next one's to find, and what the server
 * lists is one workspace's drafts, so only that workspace's entries may be compared with it.
 */
export interface DraftScope {
  readonly person: string
  readonly workspace: string
}

/** The last part of the name of the composer that starts a Thread. No Thread has this id. */
const NEW = 'new'

/**
 * The name this device keeps a place under. With `placeOf` it is the one mapping between the
 * device's place names and the contract's `DraftPlace`; nothing else builds or reads a name.
 *
 * A Thread's name used to leave its workspace out, because a Thread belongs to one already. The
 * server lists one workspace's drafts at a time, though, and a name without the workspace could
 * not say whether a Thread's draft missing from that list had been cleared or simply belonged
 * elsewhere.
 */
export const whereOf = (scope: DraftScope, place: DraftPlace): string =>
  DraftPlace.match(place, {
    NewThread: () => `${scope.person}:${scope.workspace}:${NEW}`,
    InThread: ({ thread }) => `${scope.person}:${scope.workspace}:${thread}`,
  })

const threadOf = Schema.decodeUnknownOption(ThreadId)

/** The place a name stands for, when it is this Person's in this workspace. */
export const placeOf = (scope: DraftScope, where: string): Option.Option<DraftPlace> => {
  const mine = `${scope.person}:${scope.workspace}:`
  if (!where.startsWith(mine)) return Option.none()
  const rest = where.slice(mine.length)
  return rest === NEW
    ? Option.some(DraftPlace.cases.NewThread.make({}))
    : Option.map(threadOf(rest), (thread) => DraftPlace.cases.InThread.make({ thread }))
}

/**
 * The name of a place a Person types: one Thread, or the composer that starts a new one in a
 * workspace. A request half-written for one Company must not be waiting in the composer of
 * another, where sending it would start the Thread there.
 */
export const draftPlace = (
  person: string,
  spot: { readonly workspace: string; readonly thread: Option.Option<ThreadId> },
) =>
  whereOf(
    { person, workspace: spot.workspace },
    Option.match(spot.thread, {
      onNone: () => DraftPlace.cases.NewThread.make({}),
      onSome: (thread) => DraftPlace.cases.InThread.make({ thread }),
    }),
  )

const entryIn = (drafts: Drafts, where: string) =>
  Option.fromUndefinedOr(drafts.entries.find((draft) => draft.where === where))

/** The words left in a place, or none. */
export const draftIn = (drafts: Drafts, where: string): string =>
  Option.match(entryIn(drafts, where), { onNone: () => '', onSome: (draft) => draft.text })

/** Words that are only space are no draft: what is kept, and sent to be kept, is nothing. */
const wordsOf = (text: string) => (text.trim().length === 0 ? '' : text)

/** The drafts with one place's entry replaced, newest first, or taken out. */
const placing = (drafts: Drafts, where: string, entry: Option.Option<Kept>): Drafts => {
  const others = drafts.entries.filter((draft) => draft.where !== where)
  return {
    version: 2,
    entries: Option.match(entry, {
      onNone: () => others,
      onSome: (kept) => [kept, ...others].slice(0, KEPT),
    }),
  }
}

/**
 * The drafts after the Person typed in a place: its words replaced, and owed to the server.
 *
 * Words that are only space are no draft at all, so sending a message (which empties the
 * composer) removes its draft. When the server may still hold words for the place (this device
 * took some, or a save is owed), the emptied entry stays until the server has been told.
 */
export const withDraft = (drafts: Drafts, where: string, text: string, now: number): Drafts => {
  const before = entryIn(drafts, where)
  const words = wordsOf(text)
  const taken = Option.match(before, {
    onNone: () => ({ revision: 0, savedAt: 0 }),
    onSome: (held) => ({ revision: held.revision, savedAt: held.savedAt }),
  })
  const serverMayHold = Option.exists(before, (held) => held.revision > 0 || held.unsaved)
  return placing(
    drafts,
    where,
    words.length === 0 && !serverMayHold
      ? Option.none()
      : Option.some({
          where,
          text: words,
          at: now,
          revision: taken.revision,
          savedAt: taken.savedAt,
          unsaved: true,
        }),
  )
}

/** One place's keystrokes the server has not been given: where, and the words as they stand. */
export interface Owed {
  readonly where: string
  readonly place: DraftPlace
  /** Empty when the place was emptied, which is how a draft is cleared everywhere. */
  readonly text: string
}

/**
 * Everything this device owes the server where the Person now is: each place with keystrokes not
 * yet saved, and its latest words. This is the whole answer to "what do we send": after typing,
 * and after reconnecting, where a place with unsaved keystrokes saves and every other place takes
 * the server's (`heard`).
 */
export const owed = (drafts: Drafts, scope: DraftScope): ReadonlyArray<Owed> =>
  drafts.entries.flatMap((entry) =>
    entry.unsaved
      ? Option.match(placeOf(scope, entry.where), {
          onNone: () => [],
          onSome: (place) => [{ where: entry.where, place, text: entry.text }],
        })
      : [],
  )

/** The request that saves one owed place, signed with this installation's name. */
export const saveOf = (sent: Owed, device: string): SaveDraftRequest => ({
  place: sent.place,
  text: sent.text,
  device,
})

/**
 * The drafts after the server answered a save.
 *
 * The answer is about the words that were sent. If the Person has typed since, the place still
 * owes its newer words and stays unsaved; only the revision is taken, so the echo of this save is
 * not mistaken for news. A cleared place has no revision any more: the server's count starts
 * again at 1 with the next save.
 */
export const saved = (drafts: Drafts, sent: Owed, outcome: DraftSaved): Drafts =>
  Option.match(entryIn(drafts, sent.where), {
    onNone: () => drafts,
    onSome: (held) => {
      const still = held.text !== sent.text
      return placing(
        drafts,
        sent.where,
        DraftSaved.match(outcome, {
          Kept: ({ draft }) =>
            Option.some({
              where: held.where,
              text: held.text,
              at: held.at,
              revision: draft.revision,
              savedAt: draft.savedAt,
              unsaved: still,
            }),
          Cleared: () =>
            still
              ? Option.some({
                  where: held.where,
                  text: held.text,
                  at: held.at,
                  revision: 0,
                  savedAt: 0,
                  unsaved: true,
                })
              : Option.none(),
        }),
      )
    },
  })

/**
 * The drafts after the server refused a save for good: the Thread is gone, or is not this
 * Person's to write in. Asking again cannot change that, so the place stops owing those words.
 * They stay on the device, where the Person typed them; an emptied place has nothing to keep.
 */
export const abandoned = (drafts: Drafts, sent: Owed): Drafts =>
  Option.match(entryIn(drafts, sent.where), {
    onNone: () => drafts,
    onSome: (held) =>
      held.text !== sent.text
        ? drafts
        : placing(
            drafts,
            sent.where,
            held.text.length === 0
              ? Option.none()
              : Option.some({
                  where: held.where,
                  text: held.text,
                  at: held.at,
                  revision: held.revision,
                  savedAt: held.savedAt,
                  unsaved: false,
                }),
          ),
  })

/**
 * Whether an arriving draft is news to a place holding `held`: a later revision, or, when the
 * count went back, a later save. A clear removes the server's row and the next save counts from 1
 * again, so a device that was away for both would otherwise hold revision 5 against the server's
 * new revision 1 forever. Both times are the server's clock.
 */
const newer = (arriving: Draft, held: Kept) =>
  arriving.revision > held.revision ||
  (arriving.revision < held.revision && arriving.savedAt > held.savedAt)

/** What one arriving draft does to the entry of its place. */
const taking = (held: Option.Option<Kept>, arriving: Draft, where: string, device: string) =>
  Option.match(held, {
    onNone: () =>
      // This installation's own save with no entry left for it: the place was emptied here
      // since, and that newer state is not undone by its own past.
      arriving.device === device
        ? Option.none<Kept>()
        : Option.some({
            where,
            text: arriving.text,
            at: arriving.savedAt,
            revision: arriving.revision,
            savedAt: arriving.savedAt,
            unsaved: false,
          }),
    onSome: (entry) => {
      // Never out from under someone typing, and never backwards.
      if (entry.unsaved || !newer(arriving, entry)) return Option.some(entry)
      return Option.some({
        where,
        // This installation's own save coming back says nothing about the words; they are
        // already here. Only how far the server has counted is taken.
        text: arriving.device === device ? entry.text : arriving.text,
        at: arriving.device === device ? entry.at : arriving.savedAt,
        revision: arriving.revision,
        savedAt: arriving.savedAt,
        unsaved: false,
      })
    },
  })

/**
 * The drafts after `WatchDrafts` said what the server holds for this Person in this workspace.
 *
 * - A draft from another device replaces a place's words only when the Person has no unsaved
 *   keystrokes there and the draft is newer than what the place took last (`newer`).
 * - This installation's own save coming back never changes words (`device`).
 * - A place the server no longer lists was cleared somewhere, or sent: it empties here too,
 *   unless it has unsaved keystrokes or never took anything from the server. The server keeps
 *   fifty drafts, as a device does, so the oldest falling off the list is the same loss on both.
 * - Places of another Person or another workspace are not in this list and are left alone.
 */
export const heard = (
  drafts: Drafts,
  scope: DraftScope,
  device: string,
  list: ReadonlyArray<Draft>,
): Drafts => {
  const arriving = new Map(list.map((draft) => [whereOf(scope, draft.place), draft]))
  const kept = drafts.entries.flatMap((entry) => {
    if (Option.isNone(placeOf(scope, entry.where))) return [entry]
    return Option.match(Option.fromUndefinedOr(arriving.get(entry.where)), {
      onNone: () => (entry.unsaved || entry.revision === 0 ? [entry] : []),
      onSome: (draft) => Option.toArray(taking(Option.some(entry), draft, entry.where, device)),
    })
  })
  const here = new Set(drafts.entries.map((entry) => entry.where))
  const added = Array.from(arriving).flatMap(([where, draft]) =>
    here.has(where) ? [] : Option.toArray(taking(Option.none(), draft, where, device)),
  )
  return { version: 2, entries: [...added, ...kept].slice(0, KEPT) }
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Drafts))
const encode = Schema.encodeSync(Schema.fromJsonString(Drafts))

/**
 * Reads drafts back from storage. Anything that is not a set of drafts (nothing stored yet, a
 * file cut short, another build's format) is no drafts: a device's storage is input like any
 * other.
 */
export const readDrafts = (stored: Option.Option<string>): Drafts =>
  Option.getOrElse(Option.flatMap(stored, decode), () => noDrafts)

/** The drafts as text to store. */
export const writeDrafts = (drafts: Drafts): string => encode(drafts)
