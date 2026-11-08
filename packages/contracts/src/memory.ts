import { Schema } from 'effect'
import { MessageId, OwedId, PersonId, ProjectId, ThreadId } from './identity.js'
import { WatchId } from './watches.js'

/** What kind of thing is remembered. */
export const MemoryKind = Schema.Literals([
  'fact',
  'preference',
  'person',
  'organization',
  'decision',
  'workstream',
] as const)
export type MemoryKind = typeof MemoryKind.Type

/** Placement and kind are separate. People pages describe relationships, never product identities. */
export const MemoryLayer = Schema.Literals([
  'self',
  'soul',
  'person',
  'memory',
  'days',
  'bank',
  'people',
  'dreams',
  'attention',
  'research',
])
export type MemoryLayer = typeof MemoryLayer.Type
export const StandingLayer = Schema.Literals(['self', 'soul', 'person', 'attention'])
export const isStandingLayer = Schema.is(StandingLayer)

export const MemoryFile = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\.md$/u),
).pipe(Schema.brand('MemoryFile'))
export type MemoryFile = typeof MemoryFile.Type

/** Standing pages have canonical addresses; storage does not impose a prompt-size limit. */
const addressCheck = Schema.makeFilter<{
  readonly layer: MemoryLayer
  readonly file: MemoryFile
}>((address) =>
  !isStandingLayer(address.layer) || address.file === `${address.layer}.md`
    ? undefined
    : 'A standing page must use its layer name as its file name.',
)
export const MemoryAddress = Schema.Struct({ layer: MemoryLayer, file: MemoryFile }).check(
  addressCheck,
)
export type MemoryAddress = typeof MemoryAddress.Type

/** Native Run ids are local to a cell. Reply sources resolve their host through the Thread. */
export const MemoryTaskId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('MemoryTaskId'),
)
/** One forget, from the plan to its receipt. */
export const MemoryForgetId = Schema.String.pipe(Schema.brand('MemoryForgetId'))
export type MemoryForgetId = typeof MemoryForgetId.Type

/**
 * Where an entry came from. `ThreadRun` is Vivid writing during a reply; `CellRun` is work in the
 * Person's cell that belongs to no Thread, such as learning after an exchange settled;
 * `HistoryLoad` is an entry carried over from before the cells; `Settings` is the Person
 * correcting an entry themselves; `Forget` is a forget rewriting or retracting it.
 */
export const MemorySource = Schema.TaggedUnion({
  HistoryLoad: { updatedAt: Schema.Finite },
  ThreadRun: { threadId: ThreadId, taskId: MemoryTaskId },
  CellRun: { personId: PersonId, taskId: MemoryTaskId },
  Settings: { at: Schema.Finite },
  Forget: { forgetId: MemoryForgetId },
})
export type MemorySource = typeof MemorySource.Type
export const MemoryAuthority = Schema.Struct({ actor: PersonId, source: MemorySource })
export type MemoryAuthority = typeof MemoryAuthority.Type
export const MemoryBasis = Schema.Literals(['said', 'guessed'])

/**
 * Where a remembered thing applies, within the Person's own memory. It is relevance, not who may
 * see it: every entry belongs to the Person whose cell holds it. Entries made before scope
 * existed are `Personal`; none is guessed into a Project.
 */
export const MemoryScope = Schema.TaggedUnion({
  Personal: {},
  Project: { projectId: ProjectId },
  Thread: { threadId: ThreadId },
})
export type MemoryScope = typeof MemoryScope.Type

/**
 * What a remembered thing rests on. `ThreadMessage` is the message it was said in, or that the
 * learner read it from; `Run` is the work that wrote it when no message is the evidence (a
 * correction in Settings, an entry carried over from before the cells). The host chooses every
 * citation; the model never names one. Entries written before citations existed cite the `Run`
 * of their recorded source and no message, because none was recorded.
 */
export const MemoryCitation = Schema.TaggedUnion({
  ThreadMessage: { threadId: ThreadId, messageId: MessageId },
  Run: { source: MemorySource },
})
export type MemoryCitation = typeof MemoryCitation.Type
export const MemoryCitations = Schema.NonEmptyArray(MemoryCitation)
export type MemoryCitations = typeof MemoryCitations.Type
export const MemoryRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('MemoryRevision'),
)
export type MemoryRevision = typeof MemoryRevision.Type

/** One remembered thing at one address: what it says, what kind it is, and whether it was said or guessed. */
export const MemoryEntry = Schema.Struct({
  ...MemoryAddress.fields,
  kind: MemoryKind,
  description: Schema.NonEmptyString.check(Schema.isMaxLength(200), Schema.isPattern(/\S/u)),
  body: Schema.NonEmptyString,
  basis: MemoryBasis,
  scope: MemoryScope,
}).check(addressCheck)
export type MemoryEntry = typeof MemoryEntry.Type

/** Every replacement and local retraction compares the revision the caller actually read. */
export const MemoryWrite = Schema.Struct({
  entry: MemoryEntry,
  expected: MemoryRevision,
  authority: MemoryAuthority,
  citations: MemoryCitations,
})
export type MemoryWrite = typeof MemoryWrite.Type
export const MemoryRetraction = Schema.Struct({
  address: MemoryAddress,
  expected: MemoryRevision,
  authority: MemoryAuthority,
})
export type MemoryRetraction = typeof MemoryRetraction.Type
export const SavedMemory = Schema.Struct({
  ...MemoryEntry.fields,
  revision: MemoryRevision,
  updatedAt: Schema.Finite,
  authority: MemoryAuthority,
  citations: MemoryCitations,
})
export type SavedMemory = typeof SavedMemory.Type
export const MemoryLine = Schema.Struct({
  ...MemoryAddress.fields,
  kind: MemoryKind,
  description: Schema.String,
  basis: MemoryBasis,
  scope: MemoryScope,
  revision: MemoryRevision,
  updatedAt: Schema.Finite,
})
export type MemoryLine = typeof MemoryLine.Type

/** Newest-first keyset pagination stays independent of the bounded response index. */
export const MemoryCursor = Schema.Struct({
  ...MemoryAddress.fields,
  updatedAt: Schema.Finite,
})
export const MemoryListing = Schema.Struct({
  layer: Schema.NullOr(MemoryLayer),
  after: Schema.NullOr(MemoryCursor),
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type MemoryListing = typeof MemoryListing.Type
export const MemoryPage = Schema.Struct({
  entries: Schema.Array(MemoryLine),
  next: Schema.NullOr(MemoryCursor),
})
export type MemoryPage = typeof MemoryPage.Type

/** Search pages follow native FTS5 relevance order within one Person's memory. */
export const MemorySearch = Schema.Struct({
  query: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  layer: Schema.NullOr(MemoryLayer),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: MemoryListing.fields.limit,
})
export type MemorySearch = typeof MemorySearch.Type
export const MemoryHit = Schema.Struct({ ...MemoryLine.fields, excerpt: Schema.String })
export const MemorySearchPage = Schema.Struct({
  entries: Schema.Array(MemoryHit),
  nextOffset: Schema.NullOr(MemorySearch.fields.offset),
})
export type MemorySearchPage = typeof MemorySearchPage.Type

/** The model can correct an FTS expression; unavailable storage requires different handling. */
export class MemorySearchInvalid extends Schema.TaggedError<MemorySearchInvalid>()(
  'MemorySearchInvalid',
  {},
  { title: 'Invalid memory search expression' },
) {}

/** Full standing pages and a derived index form the single snapshot Vivid reads every response. */
export const MemoryIndex = Schema.Struct({
  standing: Schema.Array(SavedMemory),
  lines: Schema.Array(MemoryLine),
  more: Schema.Boolean,
})
export type MemoryIndex = typeof MemoryIndex.Type

export class MemoryConflict extends Schema.TaggedError<MemoryConflict>()(
  'MemoryConflict',
  {
    address: MemoryAddress,
    expected: MemoryRevision,
    actual: MemoryRevision,
  },
  { title: 'Memory revision conflict' },
) {}

/** A Person correcting one entry from Settings, against the revision they were shown. */
export const CorrectMemoryRequest = Schema.Struct({
  entry: MemoryEntry,
  expected: MemoryRevision,
})
export type CorrectMemoryRequest = typeof CorrectMemoryRequest.Type
/**
 * What a forget does to one entry, at the revision the planner read. A standing page holds other
 * facts beside the forgotten one, so it is rewritten without it rather than removed.
 */
export const ForgetChange = Schema.TaggedUnion({
  Retract: { address: MemoryAddress, expected: MemoryRevision },
  Rewrite: { entry: MemoryEntry, expected: MemoryRevision },
})
export type ForgetChange = typeof ForgetChange.Type

/**
 * Vivid's plan, by meaning: the entries that say the thing, and the Watches and owed records
 * whose words use it. The tools resolve the names the model was shown into these ids; the server
 * checks each belongs to the acting Person.
 */
export const PlanMemoryForgetRequest = Schema.Struct({
  changes: Schema.NonEmptyArray(ForgetChange),
  watches: Schema.Array(WatchId),
  owed: Schema.Array(OwedId),
})
export type PlanMemoryForgetRequest = typeof PlanMemoryForgetRequest.Type

/**
 * A plan as the server keeps it, with what it found from data alone: the Threads the entries
 * cite that belong to another Person's cell, whose learning cannot be stopped from here.
 * Learning queued in the Person's own cell is always stopped and is not listed.
 */
export const MemoryForgetPlan = Schema.Struct({
  id: MemoryForgetId,
  ...PlanMemoryForgetRequest.fields,
  shared: Schema.Array(ThreadId),
})
export type MemoryForgetPlan = typeof MemoryForgetPlan.Type

/**
 * Forgetting. `Planned` carries out the newest plan Vivid made in the Run's own Thread, once the
 * Person confirmed it there; the model never holds the plan's id. `Entry` is the Person's Forget
 * press in Settings, which is itself the confirmation: Vivid plans and carries it out in a
 * background Run, and the receipt reads Pending until that Run settles.
 */
export const ForgetMemoryRequest = Schema.TaggedUnion({
  Planned: {},
  Entry: { address: MemoryAddress, expected: MemoryRevision },
})
export type ForgetMemoryRequest = typeof ForgetMemoryRequest.Type

/** What a forget stopped, rewrote and retracted, as counts: the receipt never repeats the fact. */
export const ForgetDone = Schema.Struct({
  retracted: Schema.Int,
  rewritten: Schema.Int,
  watches: Schema.Int,
  owed: Schema.Int,
  learning: Schema.Int,
})
export type ForgetDone = typeof ForgetDone.Type

/**
 * What can still bring the fact back, by record and never by its words. `Entry` still says it
 * (it changed after the plan, or could not be changed). `Watch` and `Owed` could not be stopped.
 * `SharedLearning` is learning in another Person's cell from a Thread the entry cites. `Reply`
 * is work admitted before the forget whose frozen context holds the entry. `Unplanned` is a
 * Settings forget whose background Run ended without carrying out a plan.
 */
export const ForgetRemaining = Schema.TaggedUnion({
  Entry: { address: MemoryAddress },
  Watch: { id: WatchId },
  Owed: { id: OwedId },
  SharedLearning: { threadId: ThreadId },
  Reply: { threadId: ThreadId },
  Unplanned: {},
})
export type ForgetRemaining = typeof ForgetRemaining.Type

/**
 * Where a forget stands. `Completed` only after the closure read everything back and found
 * nothing that can bring the fact back; otherwise `Blocked`, with what remains.
 */
export const MemoryForgetReceipt = Schema.TaggedUnion({
  Pending: { id: MemoryForgetId },
  Blocked: {
    id: MemoryForgetId,
    at: Schema.Finite,
    done: ForgetDone,
    remaining: Schema.NonEmptyArray(ForgetRemaining),
  },
  Completed: { id: MemoryForgetId, at: Schema.Finite, done: ForgetDone },
})
export type MemoryForgetReceipt = typeof MemoryForgetReceipt.Type

/** The plan's entries no longer hold the revisions it was made at; plan again from a fresh read. */
export class MemoryForgetStale extends Schema.TaggedError<MemoryForgetStale>()(
  'MemoryForgetStale',
  { id: MemoryForgetId },
  { title: 'Memory changed since the forget was planned' },
) {}

/**
 * What the Person's cell does for a forget, after the server stopped the Watches and owed
 * records: stop this Person's queued learning, change the entries, read them back, and say which
 * admitted work still holds the old memory in its frozen context. `writer` is the forget's own
 * Thread, whose Run is the one asking and is not counted.
 */
export const MemoryClosure = Schema.Struct({
  changes: Schema.NonEmptyArray(ForgetChange),
  authority: MemoryAuthority,
  writer: ThreadId,
})
export type MemoryClosure = typeof MemoryClosure.Type
export const MemoryClosed = Schema.Struct({
  retracted: Schema.Int,
  rewritten: Schema.Int,
  learning: Schema.Int,
  remaining: Schema.Array(ForgetRemaining),
})
export type MemoryClosed = typeof MemoryClosed.Type

/**
 * Everything one Person's memory holds, whole: every page and line of every layer, as Settings
 * reads each one, with when it was read. It is the Person's download of what Vivid remembers
 * about them (`docs/22-one-product.md`: a Person can "download everything held about them"), so nothing is summarised or cut.
 */
export const MemoryExport = Schema.Struct({
  exportedAt: Schema.Finite,
  entries: Schema.Array(SavedMemory),
})
export type MemoryExport = typeof MemoryExport.Type
