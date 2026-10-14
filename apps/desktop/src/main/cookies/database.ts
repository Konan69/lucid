import * as NodeFSP from 'node:fs/promises'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeSqlite from 'node:sqlite'
import { CopySignInOutcome, SignInBrowser, SignInSite } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { cookieReadFailure } from './failure.ts'

/** The boundary contains no original error or invalid row, which can carry cookie values. */
export class CookieReadFailed extends Schema.TaggedError<CookieReadFailed>()(
  'CookieReadFailed',
  {
    outcome: Schema.Union([
      CopySignInOutcome.cases.BrowserLocked,
      CopySignInOutcome.cases.PermissionDenied,
      CopySignInOutcome.cases.SourceMissing,
      CopySignInOutcome.cases.Unreadable,
      CopySignInOutcome.cases.UnsupportedEncryption,
      CopySignInOutcome.cases.UnsupportedCookieScope,
    ]),
  },
  { title: 'The browser sign-in could not be read' },
) {}

export const CookieRow = Schema.Struct({
  host_key: Schema.String,
  name: Schema.String,
  value: Schema.String,
  encrypted_value: Schema.Uint8Array,
  path: Schema.String,
  expires_seconds: Schema.Finite,
  is_secure: Schema.Int,
  is_httponly: Schema.Int,
  samesite: Schema.Literals([-1, 0, 1, 2]),
  is_persistent: Schema.Int,
  // Older Chromium schemas predate partitioned cookies and omit this column.
  top_frame_site_key: Schema.optionalKey(Schema.String),
})
export type CookieRow = typeof CookieRow.Type
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CookieRow))
const decodeVersion = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ value: Schema.FiniteFromString })]),
)

/** Actual filesystem and SQLite failures enter once. Only their classified OS fields survive. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the adapter's exception ingress; cookieReadFailure decodes the OS error fields.
export const sourceFailure = (browser: SignInBrowser, failure: unknown) =>
  new CookieReadFailed({ outcome: cookieReadFailure(browser, failure) })

/** Close before removing the owned snapshot. The source is always readOnly and timeout zero
 * turns an exclusive database lock into a refusal instead of blocking the Electron main thread. */
const snapshot = Effect.fn('DesktopSignIn.snapshot')(function* (
  browser: SignInBrowser,
  filename: string,
  target: string,
) {
  const source = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(filename, { readOnly: true, timeout: 0 }),
      catch: (failure) => sourceFailure(browser, failure),
    }),
    (database) => Effect.sync(() => database.close()),
  )
  yield* Effect.try({
    try: () => source.prepare('VACUUM INTO ?').run(target),
    catch: (failure) => sourceFailure(browser, failure),
  })
}, Effect.scoped)

/** Read a transactionally consistent snapshot instead of a potentially torn raw DB/WAL copy.
 * Each invocation owns and removes its temporary directory. SQL filters the named site's rows
 * before values enter the adapter. Adapted from Openbot CookieDatabase.snapshotCookieDatabase. */
export const readCookieDatabase = Effect.fn('DesktopSignIn.readDatabase')(function* (
  browser: SignInBrowser,
  filename: string,
  site: SignInSite,
) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SQLite and filesystem exception ingress delegates to the OS-error decoder.
  const failed = (failure: unknown) => sourceFailure(browser, failure)
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-cookies-')),
      catch: failed,
    }),
    (owned) =>
      Effect.tryPromise({
        try: () => NodeFSP.rm(owned, { recursive: true, force: true }),
        catch: failed,
      }).pipe(Effect.catch(() => Effect.logWarning('Temporary cookie snapshot cleanup failed.'))),
  )
  const target = NodePath.join(directory, 'Cookies')
  yield* Effect.tryPromise({
    try: () => NodeFSP.access(filename, NodeFS.constants.R_OK),
    catch: failed,
  })
  // Windows sharing violations can be lost behind SQLITE_CANTOPEN. This owned read handle
  // preserves libuv's EBUSY evidence and closes before SQLite starts its snapshot.
  yield* Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise({ try: () => NodeFSP.open(filename, 'r'), catch: failed }),
      (handle) =>
        Effect.tryPromise({ try: () => handle.close(), catch: failed }).pipe(
          Effect.catch(() => Effect.logWarning('Cookie read handle cleanup failed.')),
        ),
    ),
  )
  yield* snapshot(browser, filename, target)
  yield* Effect.tryPromise({ try: () => NodeFSP.chmod(target, 0o600), catch: failed })
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(target, { readOnly: true }),
      catch: failed,
    }),
    (opened) => Effect.sync(() => opened.close()),
  )
  const rows = yield* Effect.try({
    try: () =>
      database
        .prepare(
          'SELECT *, expires_utc / 1000000.0 AS expires_seconds FROM cookies WHERE host_key=? OR host_key=? OR host_key LIKE ?',
        )
        .all(site, `.${site}`, `%.${site}`),
    catch: failed,
  })
  const parsed = yield* decodeRows(rows).pipe(
    Effect.mapError(
      () => new CookieReadFailed({ outcome: CopySignInOutcome.cases.Unreadable.make({ browser }) }),
    ),
  )
  const versions = yield* Effect.try({
    try: () => database.prepare("SELECT value FROM meta WHERE key = 'version'").all(),
    catch: failed,
  })
  const version = yield* decodeVersion(versions).pipe(
    Effect.mapError(
      () => new CookieReadFailed({ outcome: CopySignInOutcome.cases.Unreadable.make({ browser }) }),
    ),
  )
  return { rows: parsed, version: version[0].value }
}, Effect.scoped)
