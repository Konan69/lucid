import { Schema } from 'effect'
import { PersonId, ThreadId } from './identity.js'
import { MemoryKind } from './memory.js'

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

export const NoteFile = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\.md$/u),
).pipe(Schema.brand('NoteFile'))
export type NoteFile = typeof NoteFile.Type

/** Four singleton pages are bounded at write ingress so preload never truncates their guidance. */
export const NOTE_BODY_LIMIT = 3500
const addressCheck = Schema.makeFilter<{ readonly layer: MemoryLayer; readonly file: NoteFile }>(
  (address) =>
    !isStandingLayer(address.layer) || address.file === `${address.layer}.md`
      ? undefined
      : 'A standing page must use its layer name as its file name.',
)
export const NoteAddress = Schema.Struct({ layer: MemoryLayer, file: NoteFile }).check(addressCheck)
export type NoteAddress = typeof NoteAddress.Type

/** Native Run ids are local to a cell. Reply sources resolve their host through the Thread. */
export const MemoryTaskId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand('MemoryTaskId'),
)
export const MemorySource = Schema.TaggedUnion({
  ThreadRun: { threadId: ThreadId, taskId: MemoryTaskId },
  CellRun: { personId: PersonId, taskId: MemoryTaskId },
})
export type MemorySource = typeof MemorySource.Type
export const MemoryAuthority = Schema.Struct({ actor: PersonId, source: MemorySource })
export type MemoryAuthority = typeof MemoryAuthority.Type
export const MemoryBasis = Schema.Literals(['said', 'guessed'])
export const MemoryRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('MemoryRevision'),
)
export type MemoryRevision = typeof MemoryRevision.Type

export const Note = Schema.Struct({
  ...NoteAddress.fields,
  kind: MemoryKind,
  description: Schema.NonEmptyString.check(Schema.isMaxLength(200), Schema.isPattern(/\S/u)),
  body: Schema.NonEmptyString.check(Schema.isMaxLength(NOTE_BODY_LIMIT)),
  basis: MemoryBasis,
}).check(addressCheck)
export type Note = typeof Note.Type

/** Every replacement and local retraction compares the revision the caller actually read. */
export const NoteWrite = Schema.Struct({
  note: Note,
  expected: MemoryRevision,
  authority: MemoryAuthority,
})
export type NoteWrite = typeof NoteWrite.Type
export const NoteRetraction = Schema.Struct({
  address: NoteAddress,
  expected: MemoryRevision,
  authority: MemoryAuthority,
})
export type NoteRetraction = typeof NoteRetraction.Type
export const SavedNote = Schema.Struct({
  ...Note.fields,
  revision: MemoryRevision,
  updatedAt: Schema.Finite,
  authority: MemoryAuthority,
})
export type SavedNote = typeof SavedNote.Type
export const NoteLine = Schema.Struct({
  ...NoteAddress.fields,
  kind: MemoryKind,
  description: Schema.String,
  basis: MemoryBasis,
  revision: MemoryRevision,
  updatedAt: Schema.Finite,
})
export type NoteLine = typeof NoteLine.Type

/** Full standing pages and a derived index form the existing single response snapshot. */
export const NoteIndex = Schema.Struct({
  standing: Schema.Array(SavedNote),
  lines: Schema.Array(NoteLine),
  more: Schema.Boolean,
})
export type NoteIndex = typeof NoteIndex.Type

export class NoteConflict extends Schema.TaggedError<NoteConflict>()(
  'NoteConflict',
  {
    address: NoteAddress,
    expected: MemoryRevision,
    actual: MemoryRevision,
  },
  { title: 'Memory revision conflict' },
) {}
