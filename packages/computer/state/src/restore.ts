import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { ComputerArchive } from './archive.ts'
import { HomeFiles, describeHome, digestOf, failedAt } from './home.ts'
import {
  ComputerId,
  Digest,
  Entry,
  type HomePath,
  type Manifest,
  changeBetween,
} from './manifest.ts'

/** This Computer has never been captured, so there is no state to put on a machine. */
export class NothingToRestore extends Schema.TaggedError<NothingToRestore>()(
  'NothingToRestore',
  {
    computerId: ComputerId,
  },
  { title: 'Nothing to restore' },
) {}

/** The archive returned bytes that are not the object the manifest named. Nothing was written. */
export class ObjectCorrupt extends Schema.TaggedError<ObjectCorrupt>()(
  'ObjectCorrupt',
  {
    computerId: ComputerId,
    digest: Digest,
    path: Schema.String,
  },
  { title: 'Archived object corrupt' },
) {}

/** After restoring, the home directory still differs from the manifest. It is not marked restored. */
export class RestoreIncomplete extends Schema.TaggedError<RestoreIncomplete>()(
  'RestoreIncomplete',
  { computerId: ComputerId, differing: Schema.Finite },
  { title: 'Restore incomplete' },
) {}

/**
 * Written last, atomically, and only after verification. Its presence is the only proof a machine
 * may act as the Computer; a machine without it, or with an older revision, must restore first.
 * It lives under `.vivid/`, which capture ignores, so it never travels to another machine.
 */
const RestoreMarker = Schema.Struct({ computerId: ComputerId, revision: Schema.Finite })
const RestoreMarkerJson = Schema.fromJsonString(RestoreMarker)
const encodeMarker = Schema.encodeEffect(RestoreMarkerJson)
const decodeMarker = Schema.decodeUnknownEffect(RestoreMarkerJson)
const markerPath = '.vivid/restored.json'

const localManifest = (manifest: Manifest, entries: Manifest['entries']): Manifest => ({
  ...manifest,
  entries,
})

/**
 * Makes the machine's home directory equal to the archived state of the Computer and proves it.
 *
 * It moves only the difference between what is on disk and the manifest, so restoring a warm
 * machine is cheap and restoring an empty one is a full download. Every file is checked against
 * its size and digest before it is renamed into place: a corrupt or truncated object fails the
 * restore instead of becoming a Person's file. The marker is written only when a second walk finds
 * no difference at all.
 */
export const restoreComputer = Effect.fn('Computer.restore')(function* (input: {
  readonly computerId: ComputerId
}) {
  const archive = yield* ComputerArchive
  const files = yield* HomeFiles
  const manifest = yield* Effect.fromOption(
    yield* archive.readManifest(input.computerId),
    () => new NothingToRestore({ computerId: input.computerId }),
  )

  const onDisk = Effect.fn('Computer.restore.onDisk')(function* () {
    const found = yield* describeHome()
    return localManifest(manifest, Object.fromEntries(found.map((item) => [item.path, item.entry])))
  })

  const place = Effect.fn('Computer.restore.place')(function* (relative: HomePath, entry: Entry) {
    if (Entry.guards.Link(entry)) {
      yield* files.link(entry.target, relative)
      return undefined
    }
    const bytes = yield* archive.readObject(input.computerId, entry.digest)
    if (bytes.byteLength !== entry.size || digestOf(bytes) !== entry.digest) {
      return yield* new ObjectCorrupt({
        computerId: input.computerId,
        digest: entry.digest,
        path: relative,
      })
    }
    yield* files.write(relative, bytes, Option.some(entry.mode))
    return undefined
  })

  const change = changeBetween(yield* onDisk(), manifest)
  yield* Effect.forEach(change.remove, (relative) => files.remove(relative), { discard: true })
  yield* Effect.forEach(change.write, ([relative, entry]) => place(relative, entry), {
    concurrency: 4,
    discard: true,
  })

  const remaining = changeBetween(yield* onDisk(), manifest)
  const differing = remaining.write.length + remaining.remove.length
  if (differing > 0) {
    return yield* new RestoreIncomplete({ computerId: input.computerId, differing })
  }

  const marker = yield* encodeMarker({
    computerId: input.computerId,
    revision: manifest.revision,
  }).pipe(Effect.mapError(failedAt('encodeMarker', markerPath)))
  yield* files.write(markerPath, new TextEncoder().encode(marker), Option.none())
  return {
    revision: manifest.revision,
    written: change.write.length,
    removed: change.remove.length,
  }
})

/**
 * The revision this machine was last proven to hold, if any. `None` covers a missing marker, an
 * unreadable one and one written for a different Computer: all three mean "restore first".
 */
export const restoredRevision = Effect.fn('Computer.restoredRevision')(function* (input: {
  readonly computerId: ComputerId
}) {
  const files = yield* HomeFiles
  const text = yield* files.readTextOption(markerPath)
  if (Option.isNone(text)) return Option.none<number>()
  const marker = yield* decodeMarker(text.value).pipe(Effect.option)
  return Option.flatMap(marker, (value) =>
    value.computerId === input.computerId ? Option.some(value.revision) : Option.none<number>(),
  )
})
