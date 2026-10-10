import * as Schema from 'effect/Schema'

/**
 * Identity of one Person's Computer. It is deliberately not a Person id: the Computer is a
 * resource a Person owns, and archive keys must never carry human identity.
 */
export const ComputerId = Schema.String.pipe(
  // The id becomes an archive key and a directory name, so its alphabet is closed here.
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)),
  Schema.brand('ComputerId'),
)
export type ComputerId = typeof ComputerId.Type

/** Lowercase hex SHA-256 of a file's bytes. It is the file's address in the archive. */
export const Digest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  Schema.brand('Digest'),
)
export type Digest = typeof Digest.Type

/**
 * A path below the Computer's home directory: forward slashes, never absolute, never `..`.
 * Restoring an untrusted manifest must not be able to write outside the home directory, so the
 * shape is enforced at decode, not at use.
 */
export const HomePath = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]+$/u)),
  Schema.brand('HomePath'),
)
export type HomePath = typeof HomePath.Type

/**
 * What the archive remembers about one path. A link is kept as a link: following it would copy
 * its target twice and break toolchains that depend on relative links.
 */
export const Entry = Schema.TaggedUnion({
  File: {
    digest: Digest,
    /** Bytes. Restore checks it before hashing, which catches truncation cheaply. */
    size: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
    /** Permission bits only (0o777 mask); ownership is the machine's concern. */
    mode: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  },
  Link: { target: Schema.String },
})
export type Entry = typeof Entry.Type

/**
 * The complete description of a Computer's durable state at one instant. The machine is
 * disposable; this document plus the files it names is the Computer.
 *
 * `revision` increases by one per accepted capture. The archive refuses a write whose revision is
 * not exactly one above what it holds, so two machines that both believe they are the Computer
 * cannot silently overwrite each other.
 */
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  computerId: ComputerId,
  revision: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  /** Epoch milliseconds at the end of the capture walk. */
  capturedAt: Schema.Finite,
  entries: Schema.Record(HomePath, Entry),
})
export type Manifest = typeof Manifest.Type

export const ManifestJson = Schema.fromJsonString(Manifest)

/** The manifest of a Computer that has never been captured. */
export const emptyManifest = (computerId: ComputerId): Manifest => ({
  version: 1,
  computerId,
  revision: 0,
  capturedAt: 0,
  entries: {},
})

const sameEntry = (left: Entry, right: Entry): boolean =>
  Entry.match(left, {
    File: (file) =>
      Entry.guards.File(right) &&
      file.digest === right.digest &&
      file.size === right.size &&
      file.mode === right.mode,
    Link: (link) => Entry.guards.Link(right) && link.target === right.target,
  })

/** What must change on one side to turn `from` into `to`. */
export interface ManifestChange {
  /** Paths to create or overwrite, with the entry they must become. */
  readonly write: ReadonlyArray<readonly [HomePath, Entry]>
  /** Paths present in `from` and absent in `to`. */
  readonly remove: ReadonlyArray<HomePath>
}

/**
 * Pure difference between two manifests. Capture uses it to decide what to upload; restore uses
 * it (against the manifest of what is already on disk) to decide what to download, so a warm
 * machine re-hydrates by moving only what changed.
 */
export const changeBetween = (from: Manifest, to: Manifest): ManifestChange => {
  // `Object.keys` forgets the brand the decoder already proved, so it is re-made, not cast.
  const paths = (manifest: Manifest) =>
    Object.keys(manifest.entries).map((key) => HomePath.make(key))
  const write = paths(to).flatMap((path): ReadonlyArray<readonly [HomePath, Entry]> => {
    const next = to.entries[path]
    const previous = from.entries[path]
    if (next === undefined) return []
    return previous !== undefined && sameEntry(previous, next) ? [] : [[path, next]]
  })
  const remove = paths(from).filter((path) => to.entries[path] === undefined)
  return { write, remove }
}

/** Every distinct file digest a manifest names: exactly the set of objects it needs to exist. */
export const digestsOf = (manifest: Manifest): ReadonlySet<Digest> =>
  new Set(
    Object.values(manifest.entries)
      .filter(Entry.guards.File)
      .map((entry) => entry.digest),
  )
