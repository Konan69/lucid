import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { installationIdentity } from './installation.ts'

/** Register disposal before any write; these fixtures never use an application data directory. */
const directory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-desktop-'))),
  (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
)

/** The stored file as it is on disk, read without the module under test. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('this app’s identity', () => {
  it.effect('is the one already kept on disk, which is left as it was', () =>
    Effect.gen(function* () {
      const path = NodePath.join(yield* directory, 'installation.json')
      const kept = '{"version":1,"installation":"3f2b8a34-6c1d-4e5f-9a7b-0c1d2e3f4a5b"}'
      NodeFS.writeFileSync(path, kept)
      expect(yield* installationIdentity(path)).toBe('3f2b8a34-6c1d-4e5f-9a7b-0c1d2e3f4a5b')
      expect(NodeFS.readFileSync(path, 'utf8')).toBe(kept)
    }),
  )

  it.effect('is made once per installation, kept on disk, and the same on every later launch', () =>
    Effect.gen(function* () {
      const root = yield* directory
      const path = NodePath.join(root, 'nested', 'installation.json')
      const first = yield* installationIdentity(path)
      expect(first).toMatch(UUID)
      // What a later launch reads is the file, so the file must name the same identity.
      expect(NodeFS.readFileSync(path, 'utf8')).toBe(`{"version":1,"installation":"${first}"}`)
      expect(yield* installationIdentity(path)).toBe(first)
      // No temporary file is left beside it.
      expect(NodeFS.readdirSync(NodePath.dirname(path))).toEqual(['installation.json'])
      // Another installation is another computer in the Person's list, never the same one.
      const other = yield* installationIdentity(NodePath.join(root, 'other', 'installation.json'))
      expect(other).toMatch(UUID)
      expect(other).not.toBe(first)
    }),
  )

  it.effect('a file that is not an identity is replaced by a new one that then stays', () =>
    Effect.gen(function* () {
      const path = NodePath.join(yield* directory, 'installation.json')
      NodeFS.writeFileSync(path, '{"version":1,"installation":"not-an-identity"}')
      const made = yield* installationIdentity(path)
      expect(made).toMatch(UUID)
      expect(NodeFS.readFileSync(path, 'utf8')).toBe(`{"version":1,"installation":"${made}"}`)
      expect(yield* installationIdentity(path)).toBe(made)
    }),
  )

  it.effect('an identity that cannot be read is not replaced by a new one', () =>
    Effect.gen(function* () {
      const path = NodePath.join(yield* directory, 'installation.json')
      NodeFS.mkdirSync(path)
      const exit = yield* Effect.exit(installationIdentity(path))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(NodeFS.statSync(path).isDirectory()).toBe(true)
    }),
  )
})
