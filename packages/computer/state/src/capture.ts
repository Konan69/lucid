import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { ComputerArchive } from './archive.ts'
import { Found, describeHome } from './home.ts'
import { type ComputerId, type Manifest, changeBetween, emptyManifest } from './manifest.ts'

/** What one capture did. `Unchanged` writes nothing, so an idle Computer costs one walk. */
export const CaptureResult = Schema.TaggedUnion({
  Unchanged: { revision: Schema.Finite },
  Captured: {
    revision: Schema.Finite,
    /** Objects actually sent; files whose bytes the archive already held are not counted. */
    uploaded: Schema.Finite,
    written: Schema.Finite,
    removed: Schema.Finite,
  },
})
export type CaptureResult = typeof CaptureResult.Type

const manifestOf = (
  computerId: ComputerId,
  revision: number,
  capturedAt: number,
  found: ReadonlyArray<Found>,
): Manifest => ({
  version: 1,
  computerId,
  revision,
  capturedAt,
  entries: Object.fromEntries(found.map((item) => [item.path, item.entry])),
})

/**
 * Copies the home directory's current state into the archive.
 *
 * Ordering is the whole contract: objects first, manifest last. A manifest is a promise that every
 * digest it names can be read, so it is only written once that is true. A crash mid-capture leaves
 * orphan objects (harmless, collectable) and the previous manifest (still complete) — never a
 * manifest that cannot be restored.
 *
 * A `ManifestConflict` means another machine captured this Computer first. It is not retried here:
 * the caller has to restore, because this machine's view is no longer the Computer.
 *
 * Design after the periodic state upload in Grok Bot's cloud machine; names and model are Vivid's.
 */
export const captureComputer = Effect.fn('Computer.capture')(function* (input: {
  readonly computerId: ComputerId
  readonly home: string
}) {
  const archive = yield* ComputerArchive
  const held = Option.getOrElse(yield* archive.readManifest(input.computerId), () =>
    emptyManifest(input.computerId),
  )
  const found = yield* describeHome(input.home)
  const capturedAt = yield* Clock.currentTimeMillis
  const next = manifestOf(input.computerId, held.revision + 1, capturedAt, found)
  const change = changeBetween(held, next)
  if (change.write.length === 0 && change.remove.length === 0) {
    return CaptureResult.cases.Unchanged.make({ revision: held.revision })
  }

  const changedPaths = new Set(change.write.map(([path]) => path))
  const uploads = yield* Effect.forEach(
    found.filter(Found.guards.File).filter((item) => changedPaths.has(item.path)),
    Effect.fn('Computer.uploadObject')(function* (item) {
      if (yield* archive.hasObject(input.computerId, item.entry.digest)) return 0
      yield* archive.writeObject(input.computerId, item.entry.digest, item.bytes)
      return 1
    }),
    { concurrency: 4 },
  )
  yield* archive.writeManifest(next)

  return CaptureResult.cases.Captured.make({
    revision: next.revision,
    uploaded: uploads.reduce<number>((total, sent) => total + sent, 0),
    written: change.write.length,
    removed: change.remove.length,
  })
})
