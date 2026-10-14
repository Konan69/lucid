import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import {
  CopySignInOutcome,
  CopySignInRequest,
  SignInCookie,
  SignInRead,
  SignInSite,
  signInHostMatches,
} from '@vivid/contracts'
import { Clock, Effect, Match, Option, Redacted, Schema } from 'effect'
import { CookieReadFailed, readCookieDatabase, sourceFailure, type CookieRow } from './database.ts'
import { CookieKeys, cookieKeys } from './keys.ts'

const decodeSite = Schema.decodeEffect(SignInSite)
const decodeProfiles = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      profile: Schema.Struct({
        info_cache: Schema.Record(Schema.String, Schema.Struct({ name: Schema.String })),
      }),
    }),
  ),
)

/** Unspecified SameSite stays unspecified; unknown integers cannot widen scope to None. */
const storedSameSite = (value: CookieRow['samesite']): SignInCookie['sameSite'] =>
  Match.value(value).pipe(
    Match.when(-1, () => 'Unspecified' as const),
    Match.when(0, () => 'None' as const),
    Match.when(1, () => 'Lax' as const),
    Match.when(2, () => 'Strict' as const),
    Match.exhaustive,
  )

/** A supported browser's actual cookie directory. Source: Openbot BrowserImport/Sources.ts.
 * Windows Chrome is still detected so an actual file lock is distinguishable from its later
 * app-bound encryption refusal. No path comes from model input except a contained profile. */
export const cookieRoot = (input: {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly localAppData: Option.Option<string>
  readonly browser: CopySignInRequest['browser']
}): Option.Option<string> => {
  if (input.platform === 'darwin')
    return Option.some(
      NodePath.join(
        input.home,
        'Library',
        'Application Support',
        input.browser === 'Chrome' ? 'Google/Chrome' : 'net.imput.helium',
      ),
    )
  if (input.platform === 'linux')
    return Option.some(
      NodePath.join(
        input.home,
        '.config',
        input.browser === 'Chrome' ? 'google-chrome' : 'net.imput.helium',
      ),
    )
  if (input.platform === 'win32')
    return Option.map(input.localAppData, (root) =>
      NodePath.join(
        root,
        input.browser === 'Chrome' ? 'Google/Chrome/User Data' : 'imput/Helium/User Data',
      ),
    )
  return Option.none()
}

/** Match the named site's rows before decrypting. Preserve secure, host-only, expiry and SameSite
 * semantics. Unknown encryption fails the copy rather than silently omitting a login cookie.
 * Source: Grok Bot decryptPosixCookieValue; Openbot ChromiumCookies domain binding and AES-GCM. */
const decrypt = Effect.fn('DesktopSignIn.decrypt')(function* (
  row: CookieRow,
  keys: CookieKeys,
  version: number,
  browser: CopySignInRequest['browser'],
) {
  if (row.encrypted_value.length === 0) return row.value
  const encrypted = Buffer.from(row.encrypted_value)
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11')
    return yield* new CookieReadFailed({
      outcome: CopySignInOutcome.cases.UnsupportedEncryption.make({ browser }),
    })
  const selected = CookieKeys.$match(keys, {
    Posix: ({ v10, v11 }) => (prefix === 'v10' ? Option.some(v10) : v11),
    Windows: ({ v10 }) => (prefix === 'v10' ? Option.some(v10) : Option.none()),
  })
  if (Option.isNone(selected))
    return yield* new CookieReadFailed({
      outcome: CopySignInOutcome.cases.UnsupportedEncryption.make({ browser }),
    })
  const key = Redacted.value(selected.value)
  return yield* Effect.try({
    try: () => {
      const payload = encrypted.subarray(3)
      const plain = CookieKeys.$match(keys, {
        Posix: () => {
          const decipher = NodeCrypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
          return Buffer.concat([decipher.update(payload), decipher.final()])
        },
        Windows: () => {
          const decipher = NodeCrypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
          decipher.setAuthTag(payload.subarray(-16))
          return Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()])
        },
      })
      if (version < 24) return plain.toString('utf8')
      const domainHash = NodeCrypto.createHash('sha256').update(row.host_key).digest()
      if (plain.length < 32 || !plain.subarray(0, 32).equals(domainHash)) return undefined
      return plain.subarray(32).toString('utf8')
    },
    catch: () =>
      new CookieReadFailed({ outcome: CopySignInOutcome.cases.Unreadable.make({ browser }) }),
  }).pipe(
    Effect.filterOrFail(
      (value): value is string => value !== undefined,
      () => new CookieReadFailed({ outcome: CopySignInOutcome.cases.Unreadable.make({ browser }) }),
    ),
  )
})

/** Plaintext rows need no keychain permission. Resolve encryption keys only when a selected
 * live cookie needs them, and retain the row alongside its decoded value. */
const values = Effect.fn('DesktopSignIn.values')(function* (input: {
  readonly rows: ReadonlyArray<CookieRow>
  readonly version: number
  readonly request: CopySignInRequest
  readonly root: string
  readonly platform: NodeJS.Platform
}) {
  if (input.rows.every((row) => row.encrypted_value.length === 0))
    return input.rows.map((row) => ({ row, value: row.value }))
  const keys = yield* cookieKeys({
    browser: input.request.browser,
    root: input.root,
    platform: input.platform,
    needsV11: input.rows.some(
      (row) => Buffer.from(row.encrypted_value).subarray(0, 3).toString('latin1') === 'v11',
    ),
  })
  return yield* Effect.forEach(
    input.rows,
    Effect.fn(function* (row) {
      return { row, value: yield* decrypt(row, keys, input.version, input.request.browser) }
    }),
  )
})

/** Do not follow a profile symlink outside the browser root. Local State's enumerated profile
 * directories are the source of authority, just as in Grok Bot resolveContainedChromeProfileDir. */
const profilePath = Effect.fn('DesktopSignIn.profile')(function* (
  request: CopySignInRequest,
  root: string,
) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Filesystem exception ingress delegates to the one OS-error decoder.
  const failed = (failure: unknown) => sourceFailure(request.browser, failure)
  const local = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(NodePath.join(root, 'Local State'), 'utf8'),
    catch: failed,
  })
  const unreadable = () =>
    new CookieReadFailed({
      outcome: CopySignInOutcome.cases.Unreadable.make({ browser: request.browser }),
    })
  const state = yield* decodeProfiles(local).pipe(Effect.mapError(unreadable))
  const profiles = Object.entries(state.profile.info_cache)
  const matching = profiles.filter(([directory, profile]) =>
    request.profile === 'Default' ? directory === 'Default' : profile.name === request.profile,
  )
  const selected = matching[0]
  if (matching.length !== 1 || selected === undefined)
    return yield* new CookieReadFailed({
      outcome: CopySignInOutcome.cases.SourceMissing.make({ browser: request.browser }),
    })
  const realRoot = yield* Effect.tryPromise({ try: () => NodeFSP.realpath(root), catch: failed })
  const realProfile = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(NodePath.join(realRoot, selected[0])),
    catch: failed,
  })
  if (NodePath.dirname(realProfile) !== realRoot) return yield* unreadable()
  const network = NodePath.join(realProfile, 'Network', 'Cookies')
  const newer = yield* Effect.tryPromise({ try: () => NodeFSP.stat(network), catch: failed }).pipe(
    Effect.as(true),
    Effect.catchTag('CookieReadFailed', ({ outcome }) =>
      CopySignInOutcome.guards.SourceMissing(outcome)
        ? Effect.succeed(false)
        : Effect.fail(new CookieReadFailed({ outcome })),
    ),
  )
  return newer ? network : NodePath.join(realProfile, 'Cookies')
})

/** One invocation reads one chosen profile again. No cached failure, hidden source fallback or
 * browser termination survives to the next invocation, so a quit-and-retry can actually succeed. */
export const readChromeSignIn = Effect.fn('DesktopSignIn.read')(function* (input: {
  readonly request: CopySignInRequest
  readonly root: string
  readonly platform: NodeJS.Platform
}) {
  const { request } = input
  const stored = yield* readCookieDatabase(
    request.browser,
    yield* profilePath(request, input.root),
    request.site,
  )
  const now = (yield* Clock.currentTimeMillis) / 1000
  const rows = stored.rows.filter(
    (row) =>
      signInHostMatches(request.site, row.host_key) &&
      (row.is_persistent === 0 || row.expires_seconds - 11_644_473_600 > now),
  )
  if (rows.length === 0) return SignInRead.cases.NothingToCopy.make({})
  // The target contract has no partition key. Dropping one would turn a scoped cookie into
  // a cookie available in every top-level site, so refuse the entire transfer before decryption.
  if (rows.some((row) => row.top_frame_site_key !== undefined && row.top_frame_site_key !== ''))
    return yield* new CookieReadFailed({
      outcome: CopySignInOutcome.cases.UnsupportedCookieScope.make({ browser: request.browser }),
    })
  const collected = yield* values({
    rows,
    version: stored.version,
    request,
    root: input.root,
    platform: input.platform,
  })
  const cookies = yield* Effect.forEach(
    collected,
    Effect.fn('DesktopSignIn.cookie')(
      function* ({ row, value }) {
        const bare = row.host_key.startsWith('.') ? row.host_key.slice(1) : row.host_key
        const host = yield* decodeSite(bare)
        const scope = row.host_key.startsWith('.')
          ? SignInCookie.fields.scope.cases.Domain.make({ domain: host })
          : SignInCookie.fields.scope.cases.Host.make({ host })
        const sameSite = storedSameSite(row.samesite)
        return yield* SignInCookie.makeEffect({
          name: row.name,
          value: Redacted.make(value),
          scope,
          path: row.path,
          secure: row.is_secure !== 0,
          httpOnly: row.is_httponly !== 0,
          sameSite,
          expiry:
            row.is_persistent === 0
              ? SignInCookie.fields.expiry.cases.Session.make({})
              : SignInCookie.fields.expiry.cases.Persistent.make({
                  seconds: row.expires_seconds - 11_644_473_600,
                }),
        })
      },
      Effect.mapError(
        () =>
          new CookieReadFailed({
            outcome: CopySignInOutcome.cases.Unreadable.make({ browser: request.browser }),
          }),
      ),
    ),
  )
  return yield* SignInRead.cases.Collected.makeEffect({ cookies }).pipe(
    Effect.mapError(
      () =>
        new CookieReadFailed({
          outcome: CopySignInOutcome.cases.Unreadable.make({ browser: request.browser }),
        }),
    ),
  )
})
