import * as NodeCrypto from 'node:crypto'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import { CopySignInOutcome, SignInBrowser } from '@vivid/contracts'
import { Data, Effect, Option, Redacted, Schema } from 'effect'
import { CookieReadFailed } from './database.ts'
import { cookieKeyFailure, cookieReadFailure } from './failure.ts'

/** OSCrypt keys have different algorithms on Windows and POSIX. A prefix selects exactly one
 * key, never a list of guesses. Derived from Grok Bot chrome-import-worker and Openbot ChromiumKeys. */
export type CookieKeys = Data.TaggedEnum<{
  Posix: {
    readonly v10: Redacted.Redacted<Buffer>
    readonly v11: Option.Option<Redacted.Redacted<Buffer>>
  }
  Windows: { readonly v10: Redacted.Redacted<Buffer> }
}>
export const CookieKeys = Data.taggedEnum<CookieKeys>()

/** Missing, denied and unsupported keys never retain subprocess stderr, paths or key values. */
const refused = (browser: SignInBrowser) =>
  new CookieReadFailed({
    outcome: CopySignInOutcome.cases.KeyUnavailable.make({ browser }),
  })

/** A narrow platform adapter. Keys enter on piped stdin and leave on private stdout, never in
 * arguments, logs or the model. execFile owns cancellation and a bounded stdout buffer. Keychain and libsecret may wait for
 * human approval, so the enclosing consent/link authority owns their lifetime. */
const readKey = Effect.fn('DesktopSignIn.readKey')(function* (
  browser: SignInBrowser,
  command: string,
  args: ReadonlyArray<string>,
  input: string,
) {
  const stdout = yield* Effect.callback<string, CookieReadFailed>((resume, signal) => {
    const child = NodeChildProcess.execFile(
      command,
      args,
      { signal, maxBuffer: 65_536, windowsHide: true },
      (error, output) =>
        resume(
          error === null
            ? Effect.succeed(output)
            : Effect.fail(new CookieReadFailed({ outcome: cookieKeyFailure(browser, error) })),
        ),
    )
    if (child.stdin !== null) child.stdin.end(input)
  })
  if (stdout.trim().length === 0) return yield* refused(browser)
  return Redacted.make(stdout.trim())
})

const WindowsState = Schema.Struct({
  os_crypt: Schema.Struct({
    encrypted_key: Schema.String,
    app_bound_encrypted_key: Schema.optionalKey(Schema.String),
  }),
})
const decodeWindowsState = Schema.decodeEffect(Schema.fromJsonString(WindowsState))

/** Windows forks that retain DPAPI can be read as the same user. App-bound Chrome cannot, even
 * after it quits. That state is reported honestly instead of asking for an ineffective retry.
 * Source: Openbot ChromiumKeys.decodeWindowsWrappedKey and unwrapWindowsDpapiKey. */
const windows = Effect.fn('DesktopSignIn.windowsKey')(function* (
  browser: SignInBrowser,
  root: string,
) {
  const text = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(NodePath.join(root, 'Local State'), 'utf8'),
    catch: (failure) => new CookieReadFailed({ outcome: cookieReadFailure(browser, failure) }),
  })
  const state = yield* decodeWindowsState(text).pipe(
    Effect.mapError(
      () => new CookieReadFailed({ outcome: CopySignInOutcome.cases.Unreadable.make({ browser }) }),
    ),
  )
  if (state.os_crypt.app_bound_encrypted_key !== undefined)
    return yield* new CookieReadFailed({
      outcome: CopySignInOutcome.cases.UnsupportedEncryption.make({ browser }),
    })
  const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64')
  if (!wrapped.subarray(0, 5).equals(Buffer.from('DPAPI')))
    return yield* new CookieReadFailed({
      outcome: CopySignInOutcome.cases.Unreadable.make({ browser }),
    })
  const script =
    'Add-Type -AssemblyName System.Security;$value=[Console]::In.ReadToEnd();$encrypted=[Convert]::FromBase64String($value);$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($plain))'
  const encoded = yield* readKey(
    browser,
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    wrapped.subarray(5).toString('base64'),
  )
  const key = Buffer.from(Redacted.value(encoded), 'base64')
  if (key.length !== 32) return yield* refused(browser)
  return CookieKeys.Windows({ v10: Redacted.make(key) })
})

/** Keyring access is needed only when a selected row uses it. Linux v10 uses Chromium's
 * documented peanuts key. macOS uses the browser's named Safe Storage Keychain entry. */
export const cookieKeys = Effect.fn('DesktopSignIn.keys')(function* (input: {
  readonly browser: SignInBrowser
  readonly root: string
  readonly platform: NodeJS.Platform
  readonly needsV11: boolean
}) {
  if (input.platform === 'win32') return yield* windows(input.browser, input.root)
  const derive = (value: string, iterations: number) =>
    Redacted.make(NodeCrypto.pbkdf2Sync(value, 'saltysalt', iterations, 16, 'sha1'))
  if (input.platform === 'linux') {
    const v10 = derive('peanuts', 1)
    if (!input.needsV11) return CookieKeys.Posix({ v10, v11: Option.none() })
    const secret = yield* readKey(
      input.browser,
      'secret-tool',
      ['lookup', 'application', input.browser === 'Helium' ? 'chromium' : 'chrome'],
      '',
    )
    return CookieKeys.Posix({ v10, v11: Option.some(derive(Redacted.value(secret), 1)) })
  }
  if (input.platform === 'darwin') {
    const service = input.browser === 'Helium' ? 'Helium Storage Key' : 'Chrome Safe Storage'
    const secret = yield* readKey(
      input.browser,
      '/usr/bin/security',
      ['find-generic-password', '-ws', service],
      '',
    )
    const key = derive(Redacted.value(secret), 1003)
    return CookieKeys.Posix({ v10: key, v11: Option.none() })
  }
  return yield* new CookieReadFailed({
    outcome: CopySignInOutcome.cases.UnsupportedEncryption.make({ browser: input.browser }),
  })
})
