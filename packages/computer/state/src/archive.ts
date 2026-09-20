import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { ComputerId, Digest, Manifest, ManifestJson, emptyManifest } from './manifest.ts'

const decodeManifest = Schema.decodeUnknownEffect(ManifestJson)
const encodeManifest = Schema.encodeEffect(ManifestJson)

/** The archive could not be reached or refused the operation. Retrying later is reasonable. */
export class ArchiveUnavailable extends Schema.TaggedError<ArchiveUnavailable>()(
  'ArchiveUnavailable',
  { operation: Schema.String },
  { title: 'Computer archive unavailable' },
) {}

/** A manifest exists but does not decode. Restoring from it would be guessing. */
export class ManifestUnreadable extends Schema.TaggedError<ManifestUnreadable>()(
  'ManifestUnreadable',
  { computerId: ComputerId },
  { title: 'Computer manifest unreadable' },
) {}

/**
 * Another machine captured this Computer since this one last read it. The loser must restore
 * before it may capture again; overwriting would discard the other machine's work.
 */
export class ManifestConflict extends Schema.TaggedError<ManifestConflict>()(
  'ManifestConflict',
  {
    computerId: ComputerId,
    held: Schema.Number,
    offered: Schema.Number,
  },
  { title: 'Computer manifest conflict' },
) {}

/** A manifest names an object the archive does not hold. */
export class ObjectMissing extends Schema.TaggedError<ObjectMissing>()(
  'ObjectMissing',
  {
    computerId: ComputerId,
    digest: Digest,
  },
  { title: 'Archived object missing' },
) {}

export interface ComputerArchiveService {
  readonly readManifest: (
    computerId: ComputerId,
  ) => Effect.Effect<Option.Option<Manifest>, ArchiveUnavailable | ManifestUnreadable>
  /** Accepts only `held.revision + 1`; the first capture of a Computer offers revision 1. */
  readonly writeManifest: (
    manifest: Manifest,
  ) => Effect.Effect<void, ArchiveUnavailable | ManifestUnreadable | ManifestConflict>
  readonly hasObject: (
    computerId: ComputerId,
    digest: Digest,
  ) => Effect.Effect<boolean, ArchiveUnavailable>
  readonly writeObject: (
    computerId: ComputerId,
    digest: Digest,
    bytes: Uint8Array,
  ) => Effect.Effect<void, ArchiveUnavailable>
  readonly readObject: (
    computerId: ComputerId,
    digest: Digest,
  ) => Effect.Effect<Uint8Array, ArchiveUnavailable | ObjectMissing>
}

/**
 * Where a Computer's durable state lives between machines. It is the one authority for that
 * state, which is why it is a service: capture and restore must not know whether it is a bucket
 * or a directory. Objects are kept per Computer, never shared, so deleting a Computer is deleting
 * one prefix and one Person's files can never be probed through another's digests.
 */
export class ComputerArchive extends Context.Service<ComputerArchive, ComputerArchiveService>()(
  'vivid/ComputerArchive',
) {}

/**
 * An archive in a local directory: `<root>/<computerId>/manifest.json` and
 * `<root>/<computerId>/objects/<digest>`. It backs tests and single-host development. Every write
 * lands under a temporary name and is renamed into place, so a crash leaves either the old file
 * or the new one. The revision check is read-then-write and therefore only safe for one writer per
 * host; a bucket implementation must use a conditional put instead.
 */
export const directoryArchive = (root: string) =>
  Layer.effect(
    ComputerArchive,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const unavailable = (operation: string) => () => new ArchiveUnavailable({ operation })
      const manifestFile = (id: ComputerId) => path.join(root, id, 'manifest.json')
      const objectFile = (id: ComputerId, digest: Digest) => path.join(root, id, 'objects', digest)

      const writeAtomically = Effect.fn('DirectoryArchive.writeAtomically')(function* (
        file: string,
        bytes: Uint8Array,
      ) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        const staged = `${file}.${crypto.randomUUID()}.tmp`
        yield* fs.writeFile(staged, bytes)
        yield* fs.rename(staged, file)
      })

      const readManifest = Effect.fn('DirectoryArchive.readManifest')(function* (id: ComputerId) {
        const file = manifestFile(id)
        const present = yield* fs.exists(file).pipe(Effect.mapError(unavailable('readManifest')))
        if (!present) return Option.none<Manifest>()
        const text = yield* fs
          .readFileString(file)
          .pipe(Effect.mapError(unavailable('readManifest')))
        const manifest = yield* decodeManifest(text).pipe(
          Effect.mapError(() => new ManifestUnreadable({ computerId: id })),
        )
        return Option.some(manifest)
      })

      const writeManifest = Effect.fn('DirectoryArchive.writeManifest')(function* (
        manifest: Manifest,
      ) {
        const held = Option.getOrElse(yield* readManifest(manifest.computerId), () =>
          emptyManifest(manifest.computerId),
        )
        if (manifest.revision !== held.revision + 1) {
          return yield* new ManifestConflict({
            computerId: manifest.computerId,
            held: held.revision,
            offered: manifest.revision,
          })
        }
        const text = yield* encodeManifest(manifest).pipe(
          Effect.mapError(() => new ManifestUnreadable({ computerId: manifest.computerId })),
        )
        yield* writeAtomically(
          manifestFile(manifest.computerId),
          new TextEncoder().encode(text),
        ).pipe(Effect.mapError(unavailable('writeManifest')))
        return undefined
      })

      const hasObject = (id: ComputerId, digest: Digest) =>
        fs.exists(objectFile(id, digest)).pipe(Effect.mapError(unavailable('hasObject')))

      const writeObject = (id: ComputerId, digest: Digest, bytes: Uint8Array) =>
        writeAtomically(objectFile(id, digest), bytes).pipe(
          Effect.mapError(unavailable('writeObject')),
        )

      const readObject = Effect.fn('DirectoryArchive.readObject')(function* (
        id: ComputerId,
        digest: Digest,
      ) {
        if (!(yield* hasObject(id, digest))) {
          return yield* new ObjectMissing({ computerId: id, digest })
        }
        return yield* fs
          .readFile(objectFile(id, digest))
          .pipe(Effect.mapError(unavailable('readObject')))
      })

      return { readManifest, writeManifest, hasObject, writeObject, readObject }
    }),
  )
