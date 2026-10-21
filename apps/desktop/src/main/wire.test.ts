import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import { screenshotPng } from './wire.ts'

describe('the Computer’s JSON lines', () => {
  it.effect('a picture arrives as a data URL or a path; anything else is not one', () =>
    Effect.gen(function* () {
      expect(yield* screenshotPng('data:image/png;base64,iVBORw0KGgo=')).toEqual(
        Option.some('iVBORw0KGgo='),
      )
      expect(yield* screenshotPng('notepad.png')).toEqual(Option.none())
      // A path is taken only in Windows' form. Off Windows, where the gate runs, such a path is a
      // file name read against the working directory, so the read runs in a process of its own
      // (`picture.mjs`) whose working directory is a directory this case owns: the file is real,
      // the read is the app's, and nothing is written into the checkout. On Windows the temporary
      // directory is a drive path already, and the same child reads the file by it.
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-picture-'))),
        (owned) => Effect.sync(() => NodeFS.rmSync(owned, { recursive: true, force: true })),
      )
      const address =
        NodeProcess.platform === 'win32'
          ? NodePath.join(directory, 'picture.png')
          : 'C:\\picture.png'
      const file = NodePath.resolve(directory, address)
      const readThere = Effect.callback<string>((resume) => {
        const child = NodeChildProcess.execFile(
          NodeProcess.execPath,
          [NodeURL.fileURLToPath(new URL('./picture.mjs', import.meta.url)), address],
          { cwd: directory },
          (error, stdout) => resume(error === null ? Effect.succeed(stdout) : Effect.die(error)),
        )
        return Effect.sync(() => child.kill())
      })
      const picture = Buffer.from('iVBORw0KGgo=', 'base64')
      NodeFS.writeFileSync(file, picture)
      expect(yield* readThere).toBe('some:iVBORw0KGgo=')
      NodeFS.rmSync(file)
      expect(yield* readThere).toBe('none')
      // The same real file named any other way is not read at all: only the two shapes are taken.
      NodeFS.writeFileSync(file, picture)
      expect(yield* screenshotPng(NodeURL.pathToFileURL(file).href)).toEqual(Option.none())
    }),
  )
})
