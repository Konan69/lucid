import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import { ComputerArchive, ManifestConflict, directoryArchive } from './archive.ts'
import { CaptureResult, captureComputer } from './capture.ts'
import { ComputerId } from './manifest.ts'
import { restoreComputer, restoredRevision } from './restore.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const computerId = ComputerId.make('computer_test')

/** One archive directory and two machines' home directories, all removed with the test scope. */
const makeWorld = Effect.fn('ComputerStateTest.world')(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'vivid-computer-' })
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  yield* fs.makeDirectory(first)
  // Each case owns its archive and directory until its test scope closes.
  const archive = yield* Layer.build(directoryArchive(path.join(root, 'archive')))
  const write = (home: string, relative: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(home, relative)), { recursive: true })
      yield* fs.writeFileString(path.join(home, relative), text)
    })
  const read = (home: string, relative: string) => fs.readFileString(path.join(home, relative))
  return { fs, path, first, second, archive, write, read }
})

layer(platform)('Computer state', (it) => {
  it.effect('a second machine becomes the Computer from the archive alone', () =>
    Effect.gen(function* () {
      const { fs, path, first, second, archive, write, read } = yield* makeWorld()
      yield* write(first, 'notes/plan.md', 'ship it')
      yield* write(first, 'bin/run.sh', '#!/bin/sh\n')
      yield* fs.chmod(path.join(first, 'bin/run.sh'), 0o755)
      yield* fs.symlink('notes/plan.md', path.join(first, 'current'))

      yield* captureComputer({ computerId, home: first }).pipe(Effect.provide(archive))
      const restored = yield* restoreComputer({ computerId, home: second }).pipe(
        Effect.provide(archive),
      )

      expect(restored.revision).toBe(1)
      expect(yield* read(second, 'notes/plan.md')).toBe('ship it')
      expect((yield* fs.stat(path.join(second, 'bin/run.sh'))).mode & 0o777).toBe(0o755)
      expect(yield* fs.readLink(path.join(second, 'current'))).toBe('notes/plan.md')
      expect(yield* restoredRevision({ computerId, home: second })).toEqual(Option.some(1))
    }),
  )

  it.effect('regenerable state and the restore marker never reach the archive', () =>
    Effect.gen(function* () {
      const { fs, path, first, second, archive, write } = yield* makeWorld()
      yield* write(first, 'app/index.ts', 'export {}')
      yield* write(first, 'app/node_modules/pkg/index.js', 'junk')
      yield* write(first, '.cache/big', 'junk')
      yield* write(first, '.vivid/restored.json', '{"computerId":"other","revision":9}')

      yield* captureComputer({ computerId, home: first }).pipe(Effect.provide(archive))
      yield* restoreComputer({ computerId, home: second }).pipe(Effect.provide(archive))

      expect(yield* fs.exists(path.join(second, 'app/index.ts'))).toBe(true)
      expect(yield* fs.exists(path.join(second, 'app/node_modules'))).toBe(false)
      expect(yield* fs.exists(path.join(second, '.cache'))).toBe(false)
      expect(yield* restoredRevision({ computerId, home: second })).toEqual(Option.some(1))
    }),
  )

  it.effect('a later capture sends only what changed and restore removes what was deleted', () =>
    Effect.gen(function* () {
      const { fs, path, first, second, archive, write, read } = yield* makeWorld()
      yield* write(first, 'keep.txt', 'same')
      yield* write(first, 'edit.txt', 'before')
      yield* write(first, 'gone.txt', 'bye')
      yield* captureComputer({ computerId, home: first }).pipe(Effect.provide(archive))
      yield* restoreComputer({ computerId, home: second }).pipe(Effect.provide(archive))

      yield* write(first, 'edit.txt', 'after')
      yield* fs.remove(path.join(first, 'gone.txt'))
      const second_capture = yield* captureComputer({ computerId, home: first }).pipe(
        Effect.provide(archive),
      )
      const idle = yield* captureComputer({ computerId, home: first }).pipe(Effect.provide(archive))
      yield* restoreComputer({ computerId, home: second }).pipe(Effect.provide(archive))

      expect(second_capture).toEqual(
        CaptureResult.cases.Captured.make({ revision: 2, uploaded: 1, written: 1, removed: 1 }),
      )
      expect(idle).toEqual(CaptureResult.cases.Unchanged.make({ revision: 2 }))
      expect(yield* read(second, 'edit.txt')).toBe('after')
      expect(yield* read(second, 'keep.txt')).toBe('same')
      expect(yield* fs.exists(path.join(second, 'gone.txt'))).toBe(false)
    }),
  )

  it.effect('a corrupt object fails the restore and the machine is not marked restored', () =>
    Effect.gen(function* () {
      const { fs, path, first, second, archive, write } = yield* makeWorld()
      yield* write(first, 'secret.txt', 'original')
      yield* captureComputer({ computerId, home: first }).pipe(Effect.provide(archive))
      const objects = path.join(path.dirname(first), 'archive', computerId, 'objects')
      const [digest] = yield* fs.readDirectory(objects)
      yield* fs.writeFileString(path.join(objects, String(digest)), 'tampered')

      const failure = yield* restoreComputer({ computerId, home: second }).pipe(
        Effect.provide(archive),
        Effect.flip,
      )

      expect(failure._tag).toBe('ObjectCorrupt')
      expect(yield* fs.exists(path.join(second, 'secret.txt'))).toBe(false)
      expect(yield* restoredRevision({ computerId, home: second })).toEqual(Option.none())
    }),
  )

  it.effect('a machine with a stale view cannot overwrite a newer capture', () =>
    Effect.gen(function* () {
      const { first, second, archive, write } = yield* makeWorld()
      yield* write(first, 'a.txt', 'one')
      yield* captureComputer({ computerId, home: first }).pipe(Effect.provide(archive))
      yield* restoreComputer({ computerId, home: second }).pipe(Effect.provide(archive))
      yield* write(second, 'b.txt', 'from the second machine')
      yield* captureComputer({ computerId, home: second }).pipe(Effect.provide(archive))

      // The first machine never restored revision 2, but offers its own revision 2.
      const stale = yield* Effect.gen(function* () {
        const service = yield* ComputerArchive
        return yield* service.writeManifest({
          version: 1,
          computerId,
          revision: 2,
          capturedAt: 0,
          entries: {},
        })
      }).pipe(Effect.provide(archive), Effect.flip)

      expect(stale).toEqual(new ManifestConflict({ computerId, held: 2, offered: 2 }))
    }),
  )

  it.effect('a Computer that was never captured has nothing to restore', () =>
    Effect.gen(function* () {
      const { second, archive } = yield* makeWorld()
      const failure = yield* restoreComputer({ computerId, home: second }).pipe(
        Effect.provide(archive),
        Effect.flip,
      )
      expect(failure._tag).toBe('NothingToRestore')
    }),
  )
})
