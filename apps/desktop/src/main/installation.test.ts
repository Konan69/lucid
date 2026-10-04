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

describe('this app’s identity', () => {
  it.effect('is made once and is the same on every later launch', () =>
    Effect.gen(function* () {
      const path = NodePath.join(yield* directory, 'nested', 'installation.json')
      const first = yield* installationIdentity(path)
      expect(yield* installationIdentity(path)).toBe(first)
      expect(NodeFS.readdirSync(NodePath.dirname(path))).toEqual(['installation.json'])
    }),
  )

  it.effect('a file that is not an identity is replaced by a new one that then stays', () =>
    Effect.gen(function* () {
      const path = NodePath.join(yield* directory, 'installation.json')
      NodeFS.writeFileSync(path, '{"version":1,"installation":"not-an-identity"}')
      const made = yield* installationIdentity(path)
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
