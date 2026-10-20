import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeCrypto from 'node:crypto'
import * as NodeSqlite from 'node:sqlite'
import { describe, expect, it } from '@effect/vitest'
import {
  CopySignInRequest,
  SignInCookie,
  SignInProfile,
  SignInRead,
  SignInSite,
} from '@vivid/contracts'
import { Effect, Redacted, Result } from 'effect'
import { readChromeSignIn } from './read.ts'
import { cookieKeyFailure, cookieReadFailure } from './failure.ts'
import { signInMessage } from '../../../../../packages/agent/runtime/src/tools/signins.ts'

const request = CopySignInRequest.make({
  site: SignInSite.make('github.com'),
  browser: 'Chrome',
  profile: SignInProfile.make('Default'),
})

/** Real Chromium-format encrypted rows in a disposable SQLite profile. No production cookie,
 * database, browser window, provider or user profile is opened by these tests. */
const fixture = Effect.fn('SignInTest.profile')(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-signin-test-'))),
    (owned) => Effect.promise(() => NodeFSP.rm(owned, { recursive: true, force: true })),
  )
  const network = NodePath.join(root, 'Default', 'Network')
  yield* Effect.promise(() => NodeFSP.mkdir(network, { recursive: true }))
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(root, 'Local State'),
      JSON.stringify({ profile: { info_cache: { Default: { name: 'Test' } } } }),
    ),
  )
  const filename = NodePath.join(network, 'Cookies')
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (opened) => Effect.sync(() => opened.close()),
  )
  database.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version','24'); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER)",
  )
  const put = (host: string, value: string) => {
    const key = NodeCrypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1')
    const cipher = NodeCrypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
    const content = Buffer.concat([
      NodeCrypto.createHash('sha256').update(host).digest(),
      Buffer.from(value),
    ])
    const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(content), cipher.final()])
    database
      .prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(host, 'session', '', encrypted, '/', 0, 1, 1, 1, 0)
  }
  put('.github.com', 'fixture-cookie-secret')
  put('gist.github.com', 'fixture-gist-secret')
  put('evil-github.com', 'fixture-other-secret')
  return { root, filename, database }
})

describe('copying sign-ins from a browser cookie database', () => {
  it.effect('refuses Windows app-bound encryption before asking to quit a locked browser', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* fixture()
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(source.root, 'Local State'),
            JSON.stringify({
              profile: { info_cache: { Default: { name: 'Test' } } },
              os_crypt: { app_bound_encrypted_key: 'fixture-app-bound-key' },
            }),
          ),
        )
        source.database.exec('BEGIN EXCLUSIVE')
        const read = yield* readChromeSignIn({
          request,
          root: source.root,
          platform: 'win32',
        }).pipe(Effect.result)
        expect(Result.isFailure(read)).toBe(true)
        if (Result.isFailure(read)) {
          expect(read.failure.outcome).toHaveProperty('_tag', 'UnsupportedEncryption')
          expect(signInMessage(request, read.failure.outcome)).not.toContain('Quit Chrome,')
        }
      }),
    ),
  )

  it.effect(
    'reports an actual exclusive lock, tells the person to quit, and succeeds on a fresh retry after release',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* fixture()
          const locked = yield* Effect.scoped(
            Effect.gen(function* () {
              const lock = yield* Effect.acquireRelease(
                Effect.sync(() => new NodeSqlite.DatabaseSync(source.filename)),
                (opened) => Effect.sync(() => opened.close()),
              )
              lock.exec('BEGIN EXCLUSIVE')
              return yield* readChromeSignIn({
                request,
                root: source.root,
                platform: 'linux',
              }).pipe(Effect.result)
            }),
          )
          expect(Result.isFailure(locked)).toBe(true)
          if (Result.isSuccess(locked)) return
          expect(locked.failure.outcome).toHaveProperty('_tag', 'BrowserLocked')
          expect(locked.failure.outcome).toHaveProperty('browser', 'Chrome')
          expect(signInMessage(request, locked.failure.outcome)).toContain(
            'Quit Chrome, then tell me to retry',
          )
          expect(JSON.stringify(locked.failure)).not.toContain('fixture-cookie-secret')
          const retried = yield* readChromeSignIn({ request, root: source.root, platform: 'linux' })
          expect(SignInRead.guards.Collected(retried)).toBe(true)
          if (!SignInRead.guards.Collected(retried)) return
          expect(retried.cookies.map((cookie) => Redacted.value(cookie.value))).toEqual([
            'fixture-cookie-secret',
            'fixture-gist-secret',
          ])
          expect(JSON.stringify(retried)).not.toContain('fixture-cookie-secret')
        }),
      ),
  )

  it.effect('copies persistent cookies when Chromium stores timestamps beyond safe integers', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* fixture()
        source.database.exec('ALTER TABLE cookies ADD COLUMN creation_utc INTEGER')
        source.database
          .prepare('UPDATE cookies SET creation_utc=?, expires_utc=?, is_persistent=1')
          .run(13_436_989_080_485_109n, 13_644_473_600_000_000n)
        const read = yield* readChromeSignIn({ request, root: source.root, platform: 'linux' })
        expect(SignInRead.guards.Collected(read)).toBe(true)
        if (!SignInRead.guards.Collected(read)) return
        const expiry = SignInCookie.fields.expiry.cases.Persistent.make({ seconds: 2_000_000_000 })
        expect(read.cookies.map((cookie) => cookie.expiry)).toEqual([expiry, expiry])
      }),
    ),
  )

  it.effect(
    'reads safely while the source database stays open without declaring a browser lock',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* fixture()
          const read = yield* readChromeSignIn({ request, root: source.root, platform: 'linux' })
          expect(read).toHaveProperty('_tag', 'Collected')
          expect(read).toHaveProperty('cookies.length', 2)
          expect(source.database.prepare('SELECT COUNT(*) AS count FROM cookies').get()).toEqual({
            count: 3,
          })
        }),
      ),
  )

  it.effect('an empty site has no sign-in rather than a fabricated lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* fixture()
        source.database.exec('DELETE FROM cookies')
        expect(
          yield* readChromeSignIn({ request, root: source.root, platform: 'linux' }),
        ).toHaveProperty('_tag', 'NothingToCopy')
      }),
    ),
  )

  it.effect('refuses a partitioned cookie instead of widening its scope', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* fixture()
        source.database.exec("ALTER TABLE cookies ADD COLUMN top_frame_site_key TEXT DEFAULT ''")
        source.database
          .prepare('UPDATE cookies SET top_frame_site_key=? WHERE host_key=?')
          .run('https://other.example', '.github.com')
        const read = yield* readChromeSignIn({
          request,
          root: source.root,
          platform: 'linux',
        }).pipe(Effect.result)
        expect(Result.isFailure(read)).toBe(true)
        if (Result.isFailure(read)) {
          expect(read.failure.outcome).toHaveProperty('_tag', 'UnsupportedCookieScope')
          expect(signInMessage(request, read.failure.outcome)).not.toContain('Quit')
        }
      }),
    ),
  )

  it.effect('copies plaintext cookies without asking for an unused Windows key', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* fixture()
        source.database
          .prepare('UPDATE cookies SET value=?, encrypted_value=?')
          .run('fixture-plaintext-secret', Buffer.alloc(0))
        const read = yield* readChromeSignIn({ request, root: source.root, platform: 'win32' })
        expect(read).toHaveProperty('_tag', 'Collected')
        expect(read).toHaveProperty('cookies.length', 2)
      }),
    ),
  )

  it.effect('permission and unsupported encryption failures do not tell the person to quit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* fixture()
        source.database
          .prepare('UPDATE cookies SET encrypted_value=? WHERE host_key=?')
          .run(Buffer.from('v20unsupported'), '.github.com')
        const read = yield* readChromeSignIn({
          request,
          root: source.root,
          platform: 'linux',
        }).pipe(Effect.result)
        expect(Result.isFailure(read)).toBe(true)
        if (Result.isFailure(read))
          expect(read.failure.outcome).toHaveProperty('_tag', 'UnsupportedEncryption')
        const denied = cookieReadFailure('Chrome', {
          code: 'EACCES',
          message: 'fixture-cookie-secret',
        })
        expect(denied).toHaveProperty('_tag', 'PermissionDenied')
        expect(denied).toHaveProperty('browser', 'Chrome')
        expect(signInMessage(request, denied)).not.toContain('Quit')
        const missing = cookieKeyFailure('Chrome', {
          code: 'ENOENT',
          message: 'fixture-cookie-secret',
        })
        expect(missing).toHaveProperty('_tag', 'UnsupportedEncryption')
        expect(signInMessage(request, missing)).not.toContain('Grant')
        expect(JSON.stringify(missing)).not.toContain('fixture-cookie-secret')
        const absent = cookieKeyFailure('Chrome', { code: 1 })
        expect(absent).toHaveProperty('_tag', 'KeyUnavailable')
        expect(signInMessage(request, absent)).not.toContain('Grant')
      }),
    ),
  )
})
