import { CopySignInRequest, DeviceAnswer, SignInRead } from '@vivid/contracts'
import { Clock, Config, Effect, Option } from 'effect'
import { dialog, type BrowserWindow } from 'electron'
import * as NodeOS from 'node:os'
import * as NodeProcess from 'node:process'
import { CookieReadFailed } from './database.ts'
import { cookieRoot, readChromeSignIn } from './read.ts'
import { cookieReadFailure } from './failure.ts'

/** Consent belongs to this invocation; cancellation prevents reading after a late answer.
 * Electron's abort signal also closes parented dialogs on macOS. Other platforms may leave
 * the dialog visible until dismissed. The Person's browser is never closed here. */
const allow = Effect.fn('DesktopSignIn.allow')(function* (
  request: CopySignInRequest,
  parent: BrowserWindow,
) {
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      dialog.showMessageBox(parent, {
        type: 'question',
        title: 'Copy your sign-in',
        message: `Allow Vivid to copy your ${request.site} sign-in from ${request.browser}?`,
        detail:
          'Only cookies for this site and its subdomains are copied to Vivid’s Computer. Passwords stay here. Some sites may ask you to sign in again.',
        buttons: ['Don’t allow', 'Allow once'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal,
      }),
    catch: () =>
      new CookieReadFailed({
        outcome: SignInRead.cases.Unreadable.make({ browser: request.browser }),
      }),
  })
  return result.response === 1
})

/** Consent precedes cookie access. The deadline and link scope cover the entire operation,
 * including the dialog. BrowserLocked is returned unchanged; a later request reads again. */
export const copyDeviceSignIn = Effect.fn('DesktopSignIn.copy')(function* (input: {
  readonly request: CopySignInRequest
  readonly expiresAt: number
  readonly parent: Option.Option<BrowserWindow>
}) {
  const remaining = input.expiresAt - (yield* Clock.currentTimeMillis)
  if (remaining <= 0) return Option.none<DeviceAnswer>()
  if (Option.isNone(input.parent))
    return Option.some(
      DeviceAnswer.cases.SignIn.make({
        read: SignInRead.cases.Unreadable.make({ browser: input.request.browser }),
      }),
    )
  const parent = input.parent.value
  return yield* Effect.gen(function* () {
    if (!(yield* allow(input.request, parent))) return SignInRead.cases.Declined.make({})
    const root = cookieRoot({
      platform: NodeProcess.platform,
      home: NodeOS.homedir(),
      localAppData: yield* Config.option(Config.String('LOCALAPPDATA')),
      browser: input.request.browser,
    })
    if (Option.isNone(root))
      return SignInRead.cases.SourceMissing.make({ browser: input.request.browser })
    return yield* readChromeSignIn({
      request: input.request,
      root: root.value,
      platform: NodeProcess.platform,
    })
  }).pipe(
    Effect.catchTags({
      CookieReadFailed: ({ outcome }) => Effect.succeed(outcome),
      ConfigError: () => Effect.succeed(cookieReadFailure(input.request.browser, {})),
    }),
    Effect.map((read) => DeviceAnswer.cases.SignIn.make({ read })),
    Effect.timeoutOption(remaining),
  )
})
