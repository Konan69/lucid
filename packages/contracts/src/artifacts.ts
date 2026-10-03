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

/** Who made a version: Vivid, in the Run that did it, or a Person revising by hand. */
export const ArtifactAuthor = Schema.TaggedUnion({
  Vivid: { runId: RunId },
  Person: { person: PersonSummary },
})
export type ArtifactAuthor = typeof ArtifactAuthor.Type

/** The kinds of Artifact. A closed list: each surface draws each kind natively. */
export const ArtifactKind = Schema.Literals(['document'])
export type ArtifactKind = typeof ArtifactKind.Type

/** One version in a list: everything except the text. Versions count from 1 and never repeat. */
export const ArtifactVersion = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  madeBy: ArtifactAuthor,
  at: Schema.Number,
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
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: 'Artifact', title: 'Artifact' })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

/** One Artifact opened: the text of the version being read, and every version there is. */
export const ArtifactDetail = Schema.Struct({
  artifact: Artifact,
  /** The version whose text this is: the newest, unless an older one was asked for. */
  shown: ArtifactVersion,
  body: ArtifactBody,
  /** Newest first. */
  versions: Schema.Array(ArtifactVersion),
})
export interface ArtifactDetail extends Schema.Schema.Type<typeof ArtifactDetail> {}

export const ArtifactListResponse = Schema.Struct({ artifacts: Schema.Array(Artifact) })
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
  { id: ArtifactId, version: Schema.Number },
  { title: 'The document changed while it was being edited' },
) {}

/**
 * What Vivid's `write_document` tool sends. The Thread, the Person and the Run come from the
 * delivery the tool call belongs to, never from the model. A title the Thread already has adds a
 * version to that document; a new title makes a new one. One tool for both, because "write" and
 * "revise" are the same act to the one writing.
 */
export const WriteDocumentRequest = Schema.Struct({
  title: ArtifactTitle,
  body: ArtifactBody,
  note: Schema.optionalKey(ArtifactNote),
})
export interface WriteDocumentRequest extends Schema.Schema.Type<typeof WriteDocumentRequest> {}

/** The saved document and current version, including whether this call added a version. */
export const WriteDocumentOutcome = Schema.Struct({
  title: ArtifactTitle,
  version: Schema.Number,
  /** Whether this call made the document, as opposed to revising one that was there. */
  created: Schema.Boolean,
  /** True when this call added a version; an identical newest body leaves this false. */
  changed: Schema.Boolean,
})

/** Vivid reading a document of this Thread back, by title, to work on it in a later Run. */
export const ReadDocumentRequest = Schema.Struct({ title: ArtifactTitle })

export const ReadDocumentOutcome = Schema.TaggedUnion({
  Found: { title: ArtifactTitle, version: Schema.Number, body: ArtifactBody },
  /** No document of this Thread has that title. `titles` is what it does have, to choose from. */
  Missing: { titles: Schema.Array(ArtifactTitle) },
})
export type ReadDocumentOutcome = typeof ReadDocumentOutcome.Type
