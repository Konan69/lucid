import { Schema } from 'effect'
import { ArtifactId, PersonSummary, RunId, ThreadId } from './identity.js'

/**
 * An Artifact: a durable, versioned thing made in a Thread, linked to that Thread and to the Run
 * that made each version. It is what is left when the conversation scrolls away: the report, the
 * plan, the draft someone will come back for.
 *
 * The first kind is a document, written in Markdown. Vivid makes one with its `write_document`
 * tool when the answer is something to keep and work on, not something to read once; a Person can
 * revise it by hand. Every revision is a new version and none is ever overwritten, so "what did
 * this say on Tuesday" always has an answer.
 *
 * An Artifact belongs to its Thread: whoever can see the Thread can read it, and it is named by
 * its title, which is unique within the Thread. Vivid's model never sees an identifier, only the
 * title.
 */

/** A title a Person reads in a list and Vivid uses to name the document again. */
export const ArtifactTitle = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(120))

/** A document's whole text, as Markdown. Bounded, because it is stored whole in every version. */
export const ArtifactBody = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200_000))

/** What changed in a version, in a sentence, for the version list. */
export const ArtifactNote = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200))

/** Opaque call identity supplied by the runtime outside model arguments. */
export const DocumentToolCallId = Schema.String.check(Schema.isNonEmpty()).pipe(
  Schema.brand('DocumentToolCallId'),
)
export type DocumentToolCallId = typeof DocumentToolCallId.Type

/** Who made a version: Vivid, in the Run that did it, or a Person revising by hand. */
export const ArtifactAuthor = Schema.TaggedUnion({
  Vivid: { runId: RunId },
  Person: { person: PersonSummary },
})
export type ArtifactAuthor = typeof ArtifactAuthor.Type

/** The kinds of Artifact. A closed list: each surface draws each kind natively. */
export const ArtifactKind = Schema.Literals(['document', 'file'])
export type ArtifactKind = typeof ArtifactKind.Type

/** File roles always address immutable bytes within one version. */
export const ArtifactFileRole = Schema.Literals(['output', 'source', 'preview'])
export type ArtifactFileRole = typeof ArtifactFileRole.Type
export const ArtifactFileDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand('ArtifactFileDigest'),
)
export type ArtifactFileDigest = typeof ArtifactFileDigest.Type
export const ARTIFACT_FILE_BYTES = 10_485_760
export const ArtifactFile = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  mimeType: Schema.String.check(Schema.isNonEmpty()),
  byteLength: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(ARTIFACT_FILE_BYTES),
  ),
  sha256: ArtifactFileDigest,
})
export type ArtifactFile = typeof ArtifactFile.Type
export const ArtifactSource = Schema.TaggedUnion({
  Output: {},
  Separate: { file: ArtifactFile },
})
export type ArtifactSource = typeof ArtifactSource.Type
export const ArtifactPreview = Schema.TaggedUnion({
  Output: {},
  Separate: { file: ArtifactFile },
})
export type ArtifactPreview = typeof ArtifactPreview.Type
export const ArtifactInspectionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ArtifactInspectionId'),
)
export type ArtifactInspectionId = typeof ArtifactInspectionId.Type
export const ArtifactRenderReview = Schema.Struct({
  outputDigest: ArtifactFileDigest,
  runId: RunId,
  toolCallId: DocumentToolCallId,
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
})
/** A file is editable only through its retained source; Markdown keeps its existing editor contract. */
export const ArtifactContent = Schema.TaggedUnion({
  Document: { body: ArtifactBody },
  File: {
    output: ArtifactFile,
    source: ArtifactSource,
    preview: ArtifactPreview,
    review: ArtifactRenderReview,
  },
})
export type ArtifactContent = typeof ArtifactContent.Type
export const ArtifactReference = Schema.Struct({
  id: ArtifactId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export const ArtifactMessage = Schema.Struct({
  kind: Schema.Literal('artifact'),
  artifact: ArtifactReference,
})

/** One version in a list: everything except the text. Versions count from 1 and never repeat. */
export const ArtifactVersion = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  madeBy: ArtifactAuthor,
  at: Schema.Finite,
  /** Absent on a first version, which changed nothing. */
  note: Schema.optionalKey(ArtifactNote),
})
export interface ArtifactVersion extends Schema.Schema.Type<typeof ArtifactVersion> {}

/** An Artifact as a list shows it: what it is and where it stands, without its text. */
export const Artifact = Schema.Struct({
  id: ArtifactId,
  threadId: ThreadId,
  kind: ArtifactKind,
  title: ArtifactTitle,
  /** The number of the newest version. */
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: 'Artifact', title: 'Artifact' })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

/** One Artifact opened: the text of the version being read, and every version there is. */
export const ArtifactDetail = Schema.Struct({
  artifact: Artifact,
  /** The version whose text this is: the newest, unless an older one was asked for. */
  shown: ArtifactVersion,
  content: ArtifactContent,
  /** Newest first. */
  versions: Schema.Array(ArtifactVersion),
})
export interface ArtifactDetail extends Schema.Schema.Type<typeof ArtifactDetail> {}

export const ArtifactListResponse = Schema.Struct({ artifacts: Schema.Array(Artifact) })

/**
 * What a shelf row knows of an Artifact's newest version without opening it: a document is text,
 * a file is its output's name, type and size. A row draws the type from this, so it never needs
 * the detail to say "PDF" or "Word".
 */
export const ArtifactHolds = Schema.TaggedUnion({
  Document: {},
  File: { output: ArtifactFile },
})
export type ArtifactHolds = typeof ArtifactHolds.Type

/** One Artifact on the Person's shelf: the Artifact, its newest holds and the Thread it is from. */
export const ShelvedArtifact = Schema.Struct({
  artifact: Artifact,
  holds: ArtifactHolds,
  /** The Thread's title as its list shows it, so a row can say where it was made. */
  threadTitle: Schema.String,
})
export interface ShelvedArtifact extends Schema.Schema.Type<typeof ShelvedArtifact> {}

/** Every Artifact made in a Thread the Person can read in this workspace, newest first. */
export const ArtifactShelfResponse = Schema.Struct({ artifacts: Schema.Array(ShelvedArtifact) })
export const ArtifactResponse = Schema.Struct({ artifact: Artifact })

/** Opening an Artifact, at its newest version or at one named by number. */
export const GetArtifactRequest = Schema.Struct({
  id: ArtifactId,
  version: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

/**
 * A Person revising a document by hand. `from` is the version they were reading when they started:
 * a revision made from an older version than the newest is refused with `ArtifactChanged`, so two
 * people (or a Person and Vivid) editing at once cannot silently bury each other's work.
 */
export const ReviseArtifactRequest = Schema.Struct({
  id: ArtifactId,
  from: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  body: ArtifactBody,
  note: Schema.optionalKey(ArtifactNote),
})

/** The document moved on while it was being revised. `version` is the newest there is now. */
export class ArtifactChanged extends Schema.TaggedError<ArtifactChanged>()(
  'ArtifactChanged',
  { id: ArtifactId, version: Schema.Finite },
  { title: 'The document changed while it was being edited' },
) {}

export class ArtifactNotEditable extends Schema.TaggedError<ArtifactNotEditable>()(
  'ArtifactNotEditable',
  { id: ArtifactId },
  { title: 'This file must be revised on the Computer' },
) {}

/** Capture refusals remain distinct from a renderer failure and from a stale preparation. */
export class ArtifactFileRefused extends Schema.TaggedError<ArtifactFileRefused>()(
  'ArtifactFileRefused',
  {
    role: ArtifactFileRole,
    reason: Schema.Literals(['missing', 'directory', 'unreadable', 'empty']),
  },
  { title: 'The Computer file could not be captured' },
) {}
export class ArtifactFileTooLarge extends Schema.TaggedError<ArtifactFileTooLarge>()(
  'ArtifactFileTooLarge',
  { role: ArtifactFileRole, limit: Schema.Int },
  { title: 'The file exceeds the capture limit' },
) {}
export class ArtifactComputerUnavailable extends Schema.TaggedError<ArtifactComputerUnavailable>()(
  'ArtifactComputerUnavailable',
  { message: Schema.String },
  { title: 'The Computer is unavailable' },
) {}
export class ArtifactRenderUnsupported extends Schema.TaggedError<ArtifactRenderUnsupported>()(
  'ArtifactRenderUnsupported',
  { message: Schema.String },
  { title: 'The file format cannot be rendered' },
) {}
export class ArtifactRenderFailed extends Schema.TaggedError<ArtifactRenderFailed>()(
  'ArtifactRenderFailed',
  { message: Schema.String },
  { title: 'The captured file could not be rendered' },
) {}
export class ArtifactInspectionStale extends Schema.TaggedError<ArtifactInspectionStale>()(
  'ArtifactInspectionStale',
  { inspection: ArtifactInspectionId },
  { title: 'The inspection cannot be published' },
) {}

/** Source=Output is explicit. An export retains the separate editable source bytes. */
export const ArtifactSourcePath = Schema.TaggedUnion({
  Output: {},
  Separate: { path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)) },
})
export const InspectArtifactFileRequest = Schema.Struct({
  toolCallId: DocumentToolCallId,
  path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  source: ArtifactSourcePath,
})
export type InspectArtifactFileRequest = typeof InspectArtifactFileRequest.Type
export const InspectArtifactFileOutcome = Schema.Struct({
  inspection: ArtifactInspectionId,
  output: ArtifactFile,
  source: ArtifactSource,
  preview: ArtifactPreview,
  picture: Schema.Uint8ArrayFromBase64,
})
export type InspectArtifactFileOutcome = typeof InspectArtifactFileOutcome.Type
export const PublishArtifactFileRequest = Schema.Struct({
  toolCallId: DocumentToolCallId,
  inspection: ArtifactInspectionId,
  title: ArtifactTitle,
  note: Schema.optionalKey(ArtifactNote),
  review: ArtifactRenderReview.fields.summary,
})
export type PublishArtifactFileRequest = typeof PublishArtifactFileRequest.Type
export const ArtifactFileRequest = Schema.Struct({
  id: ArtifactId,
  version: ArtifactReference.fields.version,
  role: ArtifactFileRole,
})
export type ArtifactFileRequest = typeof ArtifactFileRequest.Type

/**
 * What Vivid's `write_document` tool sends. The runtime supplies the call identity; the server
 * resolves its actual runtime response and checks the Run, Thread and Person, never the model.
 * A title the Thread already has adds a version to that document; a new title makes a new one.
 * One tool for both, because "write" and
 * "revise" are the same act to the one writing.
 */
export const WriteDocumentRequest = Schema.Struct({
  toolCallId: DocumentToolCallId,
  title: ArtifactTitle,
  body: ArtifactBody,
  note: Schema.optionalKey(ArtifactNote),
})
export interface WriteDocumentRequest extends Schema.Schema.Type<typeof WriteDocumentRequest> {}

/** The saved document and current version, including whether this call added a version. */
export const WriteDocumentOutcome = Schema.Struct({
  artifact: ArtifactReference,
  title: ArtifactTitle,
  version: Schema.Finite,
  /** Whether this call made the document, as opposed to revising one that was there. */
  created: Schema.Boolean,
  /** True when this call added a version; an identical newest body leaves this false. */
  changed: Schema.Boolean,
})

/** Vivid reading a document of this Thread back, by title, to work on it in a later Run. */
export const ReadDocumentRequest = Schema.Struct({ title: ArtifactTitle })

export const ReadDocumentOutcome = Schema.TaggedUnion({
  Found: { title: ArtifactTitle, version: Schema.Finite, body: ArtifactBody },
  /** No document of this Thread has that title. `titles` is what it does have, to choose from. */
  Missing: { titles: Schema.Array(ArtifactTitle) },
})
export type ReadDocumentOutcome = typeof ReadDocumentOutcome.Type
