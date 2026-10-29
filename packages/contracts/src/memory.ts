import { Schema } from 'effect'
import { PersonId, ThreadId } from './identity.js'

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
/**
 * Where an entry came from. `ThreadRun` is Vivid writing during a reply; `CellRun` is work in the
 * Person's cell that belongs to no Thread, such as learning after an exchange settled;
 * `HistoryLoad` is an entry carried over from before the cells; `Settings` is the Person
 * correcting an entry themselves.
 */
export const MemorySource = Schema.TaggedUnion({
  HistoryLoad: { updatedAt: Schema.Finite },
  ThreadRun: { threadId: ThreadId, taskId: MemoryTaskId },
  CellRun: { personId: PersonId, taskId: MemoryTaskId },
  Settings: { at: Schema.Finite },
})
export type MemorySource = typeof MemorySource.Type
export const MemoryAuthority = Schema.Struct({ actor: PersonId, source: MemorySource })
export type MemoryAuthority = typeof MemoryAuthority.Type
export const MemoryBasis = Schema.Literals(['said', 'guessed'])
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
}).check(addressCheck)
export type MemoryEntry = typeof MemoryEntry.Type

/** Every replacement and local retraction compares the revision the caller actually read. */
export const MemoryWrite = Schema.Struct({
  entry: MemoryEntry,
  expected: MemoryRevision,
  authority: MemoryAuthority,
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
})
export type SavedMemory = typeof SavedMemory.Type
export const MemoryLine = Schema.Struct({
  ...MemoryAddress.fields,
  kind: MemoryKind,
  description: Schema.String,
  basis: MemoryBasis,
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
/** A Person removing one entry from Settings, against the revision they were shown. */
export const ForgetMemoryRequest = Schema.Struct({
  address: MemoryAddress,
  expected: MemoryRevision,
})
export type ForgetMemoryRequest = typeof ForgetMemoryRequest.Type
