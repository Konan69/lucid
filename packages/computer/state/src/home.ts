import * as NodeCrypto from 'node:crypto'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { isRegenerable } from './ignore.ts'
import { Digest, Entry, HomePath } from './manifest.ts'

/** The home directory could not be read or written at `path`. */
export class HomeAccessFailed extends Schema.TaggedError<HomeAccessFailed>()(
  'HomeAccessFailed',
  {
    operation: Schema.String,
    path: Schema.String,
  },
  { title: 'Home directory access failed' },
) {}

/**
 * One path inspected on the machine. `File` carries its bytes and permission bits from a single
 * read so capture hashes and uploads without reading the file again.
 */
export const HomeEntry = Schema.TaggedUnion({
  Directory: {},
  File: {
    bytes: Schema.Uint8Array,
    mode: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  },
  Link: { target: Schema.String },
  Other: {},
})
export type HomeEntry = typeof HomeEntry.Type

/**
 * One thing found under the home directory. A file keeps its bytes so capture hashes and uploads
 * from a single read; a link has no bytes to keep.
 */
export const Found = Schema.TaggedUnion({
  File: { path: HomePath, entry: Entry.cases.File, bytes: Schema.Uint8Array },
  Link: { path: HomePath, entry: Entry.cases.Link },
})
export type Found = typeof Found.Type

export const failedAt = (operation: string, path: string) => () =>
  new HomeAccessFailed({ operation, path })
/** The Computer's home directory. Capture and restore depend only on this seam. */
export interface HomeFilesService {
  readonly list: (directory: string) => Effect.Effect<ReadonlyArray<string>, HomeAccessFailed>
  /**
   * Return `Link` for a symlink without following it. `stat` would archive the target's bytes
   * under the link's name.
   */
  readonly inspect: (path: HomePath) => Effect.Effect<HomeEntry, HomeAccessFailed>
  readonly readTextOption: (path: string) => Effect.Effect<Option.Option<string>>
  readonly write: (
    path: string,
    bytes: Uint8Array,
    mode: Option.Option<number>,
  ) => Effect.Effect<void, HomeAccessFailed>
  readonly link: (target: string, path: HomePath) => Effect.Effect<void, HomeAccessFailed>
  readonly remove: (path: HomePath) => Effect.Effect<void, HomeAccessFailed>
}

export class HomeFiles extends Context.Service<HomeFiles, HomeFilesService>()('vivid/HomeFiles') {}

/** SHA-256 of bytes already in memory; the digest is a file's address in the archive. */
export const digestOf = (bytes: Uint8Array): Digest =>
  Digest.make(NodeCrypto.createHash('sha256').update(bytes).digest('hex'))
/**
 * Prune regenerable paths before descent so a large package store costs one name check, not a walk.
 * Every retained file is read and hashed on each capture or restore verification walk.
 */
export const describeHome = Effect.fn('ComputerHome.describe')(function* () {
  const files = yield* HomeFiles

  const describeOne = Effect.fn('ComputerHome.describeOne')(function* (
    relative: HomePath,
  ): Effect.fn.Return<ReadonlyArray<Found>, HomeAccessFailed> {
    const inspected = yield* files.inspect(relative)
    return yield* HomeEntry.match(inspected, {
      Link: ({ target }) =>
        Effect.succeed([
          Found.cases.Link.make({
            path: relative,
            entry: Entry.cases.Link.make({ target }),
          }),
        ]),
      Directory: () => describeDirectory(relative),
      File: ({ bytes, mode }) =>
        Effect.succeed([
          Found.cases.File.make({
            path: relative,
            entry: Entry.cases.File.make({
              digest: digestOf(bytes),
              size: bytes.byteLength,
              mode,
            }),
            bytes,
          }),
        ]),
      Other: () => Effect.succeed([]),
    })
  })

  const describeDirectory = (
    relative: string,
  ): Effect.Effect<ReadonlyArray<Found>, HomeAccessFailed> =>
    Effect.gen(function* () {
      const names = yield* files.list(relative)
      const children = names
        .map((name) => HomePath.make(relative === '' ? name : `${relative}/${name}`))
        .filter((child) => !isRegenerable(child))
      const found = yield* Effect.forEach(children, describeOne, { concurrency: 8 })
      return found.flat()
    })

  return yield* describeDirectory('')
})
/**
 * Local-directory implementation of `HomeFiles` for tests and single-host development.
 * Creates the home during layer acquisition so capture and restore can list a fresh machine.
 * Writes stage to a sibling temp file and rename into place so a crash never leaves a half-written file.
 */
export const localHome = (home: string) =>
  Layer.effect(
    HomeFiles,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs
        .makeDirectory(home, { recursive: true })
        .pipe(Effect.mapError(failedAt('makeDirectory', '')))

      return {
        list: (directory) =>
          fs
            .readDirectory(path.join(home, directory))
            .pipe(Effect.mapError(failedAt('list', directory))),

        inspect: (relative) =>
          Effect.gen(function* () {
            const absolute = path.join(home, relative)
            const link = yield* fs.readLink(absolute).pipe(Effect.option)
            if (Option.isSome(link)) {
              return HomeEntry.cases.Link.make({ target: link.value })
            }
            const info = yield* fs.stat(absolute).pipe(Effect.mapError(failedAt('stat', relative)))
            if (info.type === 'Directory') return HomeEntry.cases.Directory.make({})
            if (info.type !== 'File') return HomeEntry.cases.Other.make({})
            const bytes = yield* fs
              .readFile(absolute)
              .pipe(Effect.mapError(failedAt('read', relative)))
            return HomeEntry.cases.File.make({ bytes, mode: info.mode & 0o777 })
          }),

        readTextOption: (relative) =>
          fs.readFileString(path.join(home, relative)).pipe(Effect.option),

        write: (relative, bytes, mode) =>
          Effect.gen(function* () {
            const absolute = path.join(home, relative)
            yield* fs
              .makeDirectory(path.dirname(absolute), { recursive: true })
              .pipe(Effect.mapError(failedAt('makeDirectory', relative)))
            const staged = `${absolute}.${NodeCrypto.randomUUID()}.tmp`
            yield* fs.writeFile(staged, bytes).pipe(Effect.mapError(failedAt('write', relative)))
            if (Option.isSome(mode)) {
              yield* fs.chmod(staged, mode.value).pipe(Effect.mapError(failedAt('chmod', relative)))
            }
            const exists = yield* fs
              .exists(absolute)
              .pipe(Effect.mapError(failedAt('exists', relative)))
            if (exists) {
              const info = yield* fs
                .stat(absolute)
                .pipe(Effect.mapError(failedAt('stat', relative)))
              // Rename replaces files atomically, but cannot replace a directory with a staged file.
              if (info.type === 'Directory') {
                yield* fs
                  .remove(absolute, { recursive: true })
                  .pipe(Effect.mapError(failedAt('replace', relative)))
              }
            }
            yield* fs.rename(staged, absolute).pipe(Effect.mapError(failedAt('rename', relative)))
          }),

        link: (target, relative) =>
          Effect.gen(function* () {
            const absolute = path.join(home, relative)
            yield* fs
              .makeDirectory(path.dirname(absolute), { recursive: true })
              .pipe(Effect.mapError(failedAt('makeDirectory', relative)))
            yield* fs
              .remove(absolute, { recursive: true, force: true })
              .pipe(Effect.mapError(failedAt('replace', relative)))
            yield* fs.symlink(target, absolute).pipe(Effect.mapError(failedAt('link', relative)))
          }),

        remove: (relative) =>
          fs
            .remove(path.join(home, relative), { recursive: true, force: true })
            .pipe(Effect.mapError(failedAt('remove', relative))),
      }
    }),
  )
