import * as NodeCrypto from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { isRegenerable } from './ignore.ts'
import { Digest, type Entry, HomePath } from './manifest.ts'

/** The home directory could not be read or written at `path`. */
export class HomeAccessFailed extends Schema.TaggedError<HomeAccessFailed>()(
  'HomeAccessFailed',
  {
    operation: Schema.String,
    path: Schema.String,
  },
  { title: 'Home directory access failed' },
) {}

/** One thing found under the home directory, with file bytes kept so capture hashes them once. */
export type Found =
  | {
      readonly _tag: 'File'
      readonly path: HomePath
      readonly entry: Entry
      readonly bytes: Uint8Array
    }
  | { readonly _tag: 'Link'; readonly path: HomePath; readonly entry: Entry }

const failedAt = (operation: string, path: string) => () =>
  new HomeAccessFailed({ operation, path })

/** SHA-256 of bytes already in memory; the digest is a file's address in the archive. */
export const digestOf = (bytes: Uint8Array): Digest =>
  Digest.make(NodeCrypto.createHash('sha256').update(bytes).digest('hex'))

/**
 * Walks the home directory and describes every path the archive should hold.
 *
 * Order matters per path: `readLink` is tried first because `stat` follows links, and a followed
 * link would archive its target's bytes under the link's name. Sockets, devices and pipes are
 * skipped: they are the machine's, not the Person's. Regenerable directories are pruned before
 * descent, so a large package store costs one name comparison, not a walk.
 *
 * Known cost: every file is read and hashed on every walk. That is correct and simple; when homes
 * grow, add a size-and-mtime cache in front of the hash rather than weakening the comparison.
 */
export const describeHome = Effect.fn('ComputerHome.describe')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const describeOne = Effect.fn('ComputerHome.describeOne')(function* (
    relative: HomePath,
  ): Effect.fn.Return<ReadonlyArray<Found>, HomeAccessFailed> {
    const absolute = path.join(home, relative)
    const link = yield* fs.readLink(absolute).pipe(Effect.option)
    if (Option.isSome(link)) {
      return [{ _tag: 'Link', path: relative, entry: { _tag: 'Link', target: link.value } }]
    }
    const info = yield* fs.stat(absolute).pipe(Effect.mapError(failedAt('stat', relative)))
    if (info.type === 'Directory') return yield* describeDirectory(relative)
    if (info.type !== 'File') return []
    const bytes = yield* fs.readFile(absolute).pipe(Effect.mapError(failedAt('read', relative)))
    const entry: Entry = {
      _tag: 'File',
      digest: digestOf(bytes),
      size: bytes.byteLength,
      mode: info.mode & 0o777,
    }
    return [{ _tag: 'File', path: relative, entry, bytes }]
  })

  const describeDirectory = (
    relative: string,
  ): Effect.Effect<ReadonlyArray<Found>, HomeAccessFailed> =>
    Effect.gen(function* () {
      const names = yield* fs
        .readDirectory(path.join(home, relative))
        .pipe(Effect.mapError(failedAt('list', relative)))
      const children = names
        .map((name) => HomePath.make(relative === '' ? name : `${relative}/${name}`))
        .filter((child) => !isRegenerable(child))
      const found = yield* Effect.forEach(children, describeOne, { concurrency: 8 })
      return found.flat()
    })

  return yield* describeDirectory('')
})
