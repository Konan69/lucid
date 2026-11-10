import {
  DraftPlace,
  DraftSaved,
  DraftWorkspace,
  ThreadId,
  Workspace,
  type Draft,
  type DraftListResponse,
  type MeResponse,
  type SaveDraftRequest,
} from '@vivid/contracts'
import { Array as Arr, Option, Schema } from 'effect'

/**
 * What a Person has typed and not sent, kept for each place they were typing, and how this
 * client's copy and the server's copy are brought together.
 *
 * A composer used to hold its words in component state, so leaving a Thread to check a Project,
 * answering an Approval, reloading the page or restarting the phone threw away a half-written
 * request. Drafts were then kept on the device, and words typed on a laptop never reached the
 * phone. Now the device still keeps its own copy, which is what makes typing instant and what
 * survives being offline, and the server keeps the copy every device converges on
 * (`@vivid/contracts` `drafts.ts`, whose rules these functions carry out).
 *
 * This module is the model and nothing else: what a set of drafts is, how typing changes it, what
 * it owes the server, and what an answer or an arriving list does to it. Each app supplies where
 * it is stored; `sync.ts` supplies the timing.
 *
 * Order is the server's counts and nothing else. A draft's `revision` is the Person's generation
 * at its save, a list and a save's answer carry the generation they were made at, and those
 * numbers are all that is ever compared. No clock is: not the server's `savedAt`, which two
 * servers or one stepping back would get wrong, and not the device's.
 */

/**
 * One draft as this client holds it.
 *
 * `revision` is that of the last draft this client took from the server for the place (its own
 * acknowledged save, or another client's), and is 0 while it has taken none. `unsaved` says the
 * Person has typed here since: those keystrokes are owed to the server, and until they are saved
 * nothing arriving may replace them. `at` is the device's clock at the last keystroke, kept to
 * say which draft is oldest when there are too many, and never to order two clients' words.
 *
 * `text` is empty in exactly one case: the Person emptied a place the server may still hold words
 * for. That entry is what remembers to clear it everywhere, and it goes once the server has.
 */
const Kept = Schema.Struct({
  where: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
  revision: Schema.Finite,
  unsaved: Schema.Boolean,
})
interface Kept extends Schema.Schema.Type<typeof Kept> {}

/**
 * How far this client and the server have got with one Person's drafts in one workspace.
 *
 * - `acknowledged`: the highest generation the server has answered one of this client's own
 *   saves with. A list read before that is older than words the server has already accepted.
 * - `applied`: the highest generation of a list this client has laid over its drafts.
 */
const Mark = Schema.Struct({
  where: Schema.String,
  acknowledged: Schema.Finite,
  applied: Schema.Finite,
})
interface Mark extends Schema.Schema.Type<typeof Mark> {}

/**
 * Words kept by an earlier build for a Thread, whose place cannot be named yet. That build named
 * a Thread's place without its workspace; this one needs it (`whereOf`), and only the Thread list
 * of the workspace the Thread is in can say. Until then the words wait here, safe and unshown.
 */
const Pending = Schema.Struct({
  person: Schema.String,
  thread: ThreadId,
  text: Schema.String,
  at: Schema.Finite,
})
interface Pending extends Schema.Schema.Type<typeof Pending> {}

/** Version 3: marks, pending words, and no server time in an entry. */
export const Drafts = Schema.Struct({
  version: Schema.Literal(3),
  entries: Schema.Array(Kept),
  marks: Schema.Array(Mark),
  pending: Schema.Array(Pending),
})
export interface Drafts extends Schema.Schema.Type<typeof Drafts> {}

/** How many are kept. The oldest goes first, so a device never grows a draft for every Thread. */
const KEPT = 50

const noDrafts: Drafts = { version: 3, entries: [], marks: [], pending: [] }

/**
 * Whose drafts, and in which workspace. The server takes both from who is calling and a
 * `DraftPlace` carries neither, so the device, which outlives sessions and workspaces, has to
 * name them itself: one Person's unsent words are not the next one's to find, and what the server
 * lists is one workspace's drafts, so only that workspace's entries may be compared with it.
 *
 * The workspace is the contract's own `DraftWorkspace`, the identity a list names itself by, so
 * "is this list for where the Person is" is a comparison of two of the same thing.
 */
export interface DraftScope {
  readonly person: string
  readonly workspace: DraftWorkspace
}

/** The scope the server's word on who is signed in puts a client in. */
export const draftScopeOf = (me: MeResponse): DraftScope => ({
  person: me.person.id,
  workspace: Workspace.match(me.workspace, {
    Personal: (): DraftWorkspace => DraftWorkspace.cases.Personal.make({}),
    Company: ({ company }): DraftWorkspace =>
      DraftWorkspace.cases.Company.make({ company: company.id }),
  }),
})

/** A workspace as the one word place names are built from. It is `workspaceKey`'s word. */
const wordOf = DraftWorkspace.match({
  Personal: () => 'personal',
  Company: ({ company }): string => company,
})

/** Whether two workspace identities are the same workspace. */
export const sameWorkspace = (one: DraftWorkspace, other: DraftWorkspace): boolean =>
  wordOf(one) === wordOf(other) && one._tag === other._tag

/** The last part of the name of the composer that starts a Thread. No Thread has this id. */
const NEW = 'new'

/** Everything this Person has in this workspace is named with this in front. */
const prefixOf = (person: string, workspace: string) => `${person}:${workspace}:`

/** The one place a name is built: who, where they are working, and the place there. */
const named = (person: string, workspace: string, place: DraftPlace): string =>
  DraftPlace.match(place, {
    NewThread: () => `${prefixOf(person, workspace)}${NEW}`,
    InThread: ({ thread }) => `${prefixOf(person, workspace)}${thread}`,
  })

/**
 * The name this device keeps a place under. With `placeOf` it is the one mapping between the
 * device's place names and the contract's `DraftPlace`; nothing else builds or reads a name.
 *
 * A Thread's name used to leave its workspace out, because a Thread belongs to one already. The
 * server lists one workspace's drafts at a time, though, and a name without the workspace could
 * not say whether a Thread's draft missing from that list had been cleared or simply belonged
 * elsewhere.
 */
const whereOf = (scope: DraftScope, place: DraftPlace): string =>
  named(scope.person, wordOf(scope.workspace), place)

const threadOf = Schema.decodeUnknownOption(ThreadId)

/** The place a name stands for, when it is this Person's in this workspace. */
const placeOf = (scope: DraftScope, where: string): Option.Option<DraftPlace> => {
  const mine = prefixOf(scope.person, wordOf(scope.workspace))
  if (!where.startsWith(mine)) return Option.none()
  const rest = where.slice(mine.length)
  return rest === NEW
    ? Option.some(DraftPlace.cases.NewThread.make({}))
    : Option.map(threadOf(rest), (thread) => DraftPlace.cases.InThread.make({ thread }))
}

/**
 * The name of a place a Person types, for a composer: one Thread, or the composer that starts a
 * new one in a workspace. `workspace` is `workspaceKey`'s word for where the Person is. A request
 * half-written for one Company must not be waiting in the composer of another, where sending it
 * would start the Thread there.
 */
export const draftPlace = (
  person: string,
  spot: { readonly workspace: string; readonly thread: Option.Option<ThreadId> },
) =>
  named(
    person,
    spot.workspace,
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

/** The drafts with their entries replaced and everything else as it was. */
const withEntries = (drafts: Drafts, entries: ReadonlyArray<Kept>): Drafts => ({
  version: 3,
  entries: entries.slice(0, KEPT),
  marks: drafts.marks,
  pending: drafts.pending,
})

/** The drafts with one place's entry replaced, newest first, or taken out. */
const placing = (drafts: Drafts, where: string, entry: Option.Option<Kept>): Drafts => {
  const others = drafts.entries.filter((draft) => draft.where !== where)
  return withEntries(
    drafts,
    Option.match(entry, { onNone: () => others, onSome: (kept) => [kept, ...others] }),
  )
}

/** One entry with what it took from the server, and whether it owes, changed. */
const standing = (held: Kept, revision: number, unsaved: boolean): Kept => ({
  where: held.where,
  text: held.text,
  at: held.at,
  revision,
  unsaved,
})

/**
 * The drafts after the Person typed in a place: its words replaced, and owed to the server.
 *
 * Words that are only space are no draft at all, so sending a message (which empties the
 * composer) removes its draft. When the server may still hold words for the place (this client
 * took some, or a save is owed), the emptied entry stays until the server has been told.
 */
export const withDraft = (drafts: Drafts, where: string, text: string, now: number): Drafts => {
  const before = entryIn(drafts, where)
  const words = wordsOf(text)
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
          revision: Option.match(before, { onNone: () => 0, onSome: (held) => held.revision }),
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
 * Everything this client owes the server where the Person now is: each place with keystrokes not
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

/** The request that saves one owed place, signed with this client's name. */
export const saveOf = (sent: Owed, device: string): SaveDraftRequest => ({
  place: sent.place,
  text: sent.text,
  device,
})

/** Where this client and the server stand for one scope; nothing yet is zero on both counts. */
const markIn = (drafts: Drafts, where: string): Mark =>
  Option.getOrElse(
    Option.fromUndefinedOr(drafts.marks.find((mark) => mark.where === where)),
    () => ({ where, acknowledged: 0, applied: 0 }),
  )

const markOf = (drafts: Drafts, scope: DraftScope): Mark =>
  markIn(drafts, prefixOf(scope.person, wordOf(scope.workspace)))

/** The drafts with one scope's mark replaced. A count only ever rises. */
const marking = (drafts: Drafts, before: Mark, reached: Omit<Mark, 'where'>): Drafts => ({
  version: 3,
  entries: drafts.entries,
  marks: [
    {
      where: before.where,
      acknowledged: Math.max(before.acknowledged, reached.acknowledged),
      applied: Math.max(before.applied, reached.applied),
    },
    ...drafts.marks.filter((mark) => mark.where !== before.where),
  ].slice(0, KEPT),
  pending: drafts.pending,
})

/**
 * The drafts after the server answered a save made in `scope`.
 *
 * The answer is about the words that were sent. If the Person has typed since, the place still
 * owes its newer words and stays unsaved; only the revision is taken. The answer's generation is
 * remembered as acknowledged, which is what lets a list read before this save be recognised as
 * old (`heard`). A cleared place holds the clear's generation as its revision, so a list read
 * before the clear cannot bring the words back.
 */
export const saved = (
  drafts: Drafts,
  scope: DraftScope,
  sent: Owed,
  outcome: DraftSaved,
): Drafts => {
  const reached = marking(drafts, markOf(drafts, scope), {
    acknowledged: outcome.generation,
    applied: 0,
  })
  return Option.match(entryIn(reached, sent.where), {
    onNone: () => reached,
    onSome: (held) => {
      const still = held.text !== sent.text
      return placing(
        reached,
        sent.where,
        DraftSaved.match(outcome, {
          Kept: ({ draft }) => Option.some(standing(held, draft.revision, still)),
          Cleared: ({ generation }) =>
            still ? Option.some(standing(held, generation, true)) : Option.none(),
        }),
      )
    },
  })
}

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
              : Option.some(standing(held, held.revision, false)),
          ),
  })

/** What one listed draft does to the entry of its place. */
const taking = (held: Option.Option<Kept>, arriving: Draft, where: string, device: string) =>
  Option.match(held, {
    onNone: (): Kept => ({
      where,
      text: arriving.text,
      // The device's clock is not known here and the order of a list is the server's newest
      // first, so an arrival is filed by its place in the list, not by a time.
      at: 0,
      revision: arriving.revision,
      unsaved: false,
    }),
    onSome: (entry): Kept => {
      // Never out from under someone typing, and never backwards.
      if (entry.unsaved || arriving.revision <= entry.revision) return entry
      // This client's own save coming back says nothing about the words; they are already here.
      // Only how far the server has counted is taken.
      if (arriving.device === device) return standing(entry, arriving.revision, false)
      return {
        where,
        text: arriving.text,
        at: entry.at,
        revision: arriving.revision,
        unsaved: false,
      }
    },
  })

/**
 * The drafts after `WatchDrafts` said what the server holds.
 *
 * The list is ignored whole when:
 * - it is for a workspace other than the one the Person is in (they changed workspace while it
 *   was on its way; filed here it would put that workspace's words in this one's composer);
 * - its generation is lower than the highest this client has had a save acknowledged at (it was
 *   read before that save landed; applying it deleted the words just saved);
 * - its generation is lower than a list already applied (it arrived out of order).
 *
 * Within a list that is applied:
 * - a listed draft replaces a place's words only with a higher revision than the place holds,
 *   when the Person has no unsaved keystrokes there, and when it is not this client's own save;
 * - a place the list does not have is cleared only when the list's generation is higher than
 *   the revision the place holds and the Person has no unsaved keystrokes there;
 * - places of another Person or another workspace are not in this list and are left alone.
 */
export const heard = (
  drafts: Drafts,
  scope: DraftScope,
  device: string,
  list: DraftListResponse,
): Drafts => {
  const mark = markOf(drafts, scope)
  if (
    !sameWorkspace(list.workspace, scope.workspace) ||
    list.generation < mark.acknowledged ||
    list.generation < mark.applied
  ) {
    return drafts
  }
  const arriving = new Map(list.drafts.map((draft) => [whereOf(scope, draft.place), draft]))
  const kept = drafts.entries.flatMap((entry) => {
    if (Option.isNone(placeOf(scope, entry.where))) return [entry]
    return Option.match(Option.fromUndefinedOr(arriving.get(entry.where)), {
      onNone: () => (entry.unsaved || list.generation <= entry.revision ? [entry] : []),
      onSome: (draft) => [taking(Option.some(entry), draft, entry.where, device)],
    })
  })
  const here = new Set(drafts.entries.map((entry) => entry.where))
  const added = Array.from(arriving).flatMap(([where, draft]) =>
    here.has(where) ? [] : [taking(Option.none(), draft, where, device)],
  )
  return marking(withEntries(drafts, [...added, ...kept]), mark, {
    acknowledged: 0,
    applied: list.generation,
  })
}

/**
 * The drafts after another client on this device (another tab of the browser) wrote the store
 * they share. It goes through the same rule as a list from the server: its words never replace
 * keystrokes this client has not saved, and otherwise the newer state of a place is taken, which
 * is a higher revision or words the other client is still typing. What is taken is not owed by
 * this client; the one that was typed in owes it. A place the other client no longer has is left
 * alone here: only the server's list says a draft was cleared.
 */
export const absorbed = (mine: Drafts, theirs: Drafts): Drafts => {
  const taken = new Map(theirs.entries.map((entry) => [entry.where, entry]))
  const kept = mine.entries.map((entry) =>
    Option.match(Option.fromUndefinedOr(taken.get(entry.where)), {
      onNone: () => entry,
      onSome: (other) => {
        if (entry.unsaved) return entry
        const news = other.revision > entry.revision || (other.unsaved && other.text !== entry.text)
        return news ? standing(other, Math.max(other.revision, entry.revision), false) : entry
      },
    }),
  )
  const here = new Set(mine.entries.map((entry) => entry.where))
  const added = theirs.entries.flatMap((entry) =>
    here.has(entry.where) ? [] : [standing(entry, entry.revision, false)],
  )
  return theirs.marks.reduce(
    (drafts, mark) =>
      marking(drafts, markIn(drafts, mark.where), {
        acknowledged: mark.acknowledged,
        applied: mark.applied,
      }),
    withEntries(mine, [...added, ...kept]),
  )
}

/**
 * The drafts once the session that carried them has ended: only what the Person typed on this
 * device and the server never took. Everything that came from the server, or that it has a copy
 * of, goes, with every count; it is the Person's again when they sign in, from the server. Words
 * the server never had are nowhere else, so they stay, named for their Person as they always
 * were, and are owed again by whoever signs in as that Person.
 */
export const forgotten = (drafts: Drafts): Drafts => ({
  version: 3,
  entries: drafts.entries.flatMap((entry) =>
    entry.unsaved && entry.text.length > 0 ? [standing(entry, 0, true)] : [],
  ),
  marks: [],
  pending: drafts.pending,
})

/**
 * The drafts once the Thread list of where the Person is has answered: words an earlier build
 * kept for one of those Threads now have a place name, and are owed like anything typed. Words
 * for a Thread the list does not have keep waiting: it may be in another workspace of theirs.
 * A place that already has words keeps them, and the waiting words for it are let go.
 */
export const resolved = (
  drafts: Drafts,
  scope: DraftScope,
  threads: ReadonlySet<ThreadId>,
): Drafts => {
  const found = drafts.pending.filter(
    (waiting) => waiting.person === scope.person && threads.has(waiting.thread),
  )
  if (found.length === 0) return drafts
  const rest = drafts.pending.filter((waiting) => !found.includes(waiting))
  return found.reduce<Drafts>(
    (next, waiting) => {
      const where = whereOf(scope, DraftPlace.cases.InThread.make({ thread: waiting.thread }))
      return Option.isSome(entryIn(next, where))
        ? next
        : withDraft(next, where, waiting.text, waiting.at)
    },
    { version: 3, entries: drafts.entries, marks: drafts.marks, pending: rest },
  )
}

/** The store as the first build wrote it: a place name, the words, and when. */
const DraftsV1 = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(
    Schema.Struct({ where: Schema.String, text: Schema.String, at: Schema.Finite }),
  ),
})

/**
 * The store as the first build of following wrote it. Its place names are today's; its revisions
 * were counted per place and cannot be compared with a generation.
 */
const DraftsV2 = Schema.Struct({
  version: Schema.Literal(2),
  entries: Schema.Array(
    Schema.Struct({
      where: Schema.String,
      text: Schema.String,
      at: Schema.Finite,
      unsaved: Schema.Boolean,
    }),
  ),
})

/**
 * A version 1 store as today's drafts. Nothing in it was ever given to the server, so all of it
 * is owed.
 *
 * - `person:workspace:new` is today's name for the same place and is kept as it is.
 * - `person:thread` named a Thread without its workspace. It waits in `pending` until the Thread
 *   list of the workspace it is in says where it belongs (`resolved`).
 * - Any other shape was never written by a build of Vivid and is the only thing dropped.
 */
const fromV1 = (stored: typeof DraftsV1.Type): Drafts =>
  // The store lists the newest first and typing files at the front, so it is read backwards.
  Arr.reverse(stored.entries).reduce<Drafts>((drafts, entry) => {
    if (entry.text.trim().length === 0) return drafts
    const parts = entry.where.split(':')
    const [person, second] = parts
    if (parts.length === 3 && parts[2] === NEW) {
      return withDraft(drafts, entry.where, entry.text, entry.at)
    }
    const thread = parts.length === 2 ? threadOf(second) : Option.none()
    if (person === undefined || Option.isNone(thread)) return drafts
    return {
      version: 3,
      entries: drafts.entries,
      marks: drafts.marks,
      pending: [
        ...drafts.pending,
        { person, thread: thread.value, text: entry.text, at: entry.at },
      ].slice(-KEPT),
    }
  }, noDrafts)

/**
 * A version 2 store as today's drafts: the same places and words. What it had taken from the
 * server is forgotten, because its counts mean nothing now; the next list gives each place its
 * revision, and keystrokes that were owed are still owed.
 */
const fromV2 = (stored: typeof DraftsV2.Type): Drafts => ({
  version: 3,
  entries: stored.entries
    .map((entry) => ({
      where: entry.where,
      text: entry.text,
      at: entry.at,
      revision: 0,
      unsaved: entry.unsaved,
    }))
    .slice(0, KEPT),
  marks: [],
  pending: [],
})

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Drafts))
const decodeV2 = Schema.decodeUnknownOption(Schema.fromJsonString(DraftsV2))
const decodeV1 = Schema.decodeUnknownOption(Schema.fromJsonString(DraftsV1))
const encode = Schema.encodeOption(Schema.fromJsonString(Drafts))

/**
 * Reads drafts back from storage, whichever build wrote them: today's format as it is, and each
 * earlier one through its own Schema and its own mapping (`fromV1`, `fromV2`), so an update never
 * costs a Person words they had typed. Anything that is none of them (nothing stored yet, a file
 * cut short) is no drafts: a device's storage is input like any other.
 */
export const readDrafts = (stored: Option.Option<string>): Drafts =>
  Option.getOrElse(
    Option.flatMap(stored, (text) =>
      decode(text).pipe(
        Option.orElse(() => Option.map(decodeV2(text), fromV2)),
        Option.orElse(() => Option.map(decodeV1(text), fromV1)),
      ),
    ),
    () => noDrafts,
  )

/**
 * The drafts as text to store. There is none for drafts that will not encode: the store keeps what
 * it last held, and the words stay in memory, as when a store refuses a write.
 */
export const writeDrafts = (drafts: Drafts): Option.Option<string> => encode(drafts)
