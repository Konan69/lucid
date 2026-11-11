import { defineTool as durableTool } from '@earendil-works/pi-durable'
import { executeCall, executionResult, toolResult } from './tool.ts'
import { Type } from '@earendil-works/pi-ai'
import { Tool, CopySignInOutcome, CopySignInRequest, UseWindowRequest } from '@vivid/contracts'
import { Effect, Option, Result, Schema } from 'effect'
import { Scope, type RunTool } from './scope.ts'
import { pictureResult } from './picture.ts'
import { plain, quiet, refused, type Plain } from './views.ts'

const input = Schema.Struct({
  ...CopySignInRequest.fields,
  summary: UseWindowRequest.fields.summary,
}).annotate({
  description:
    'Copy one site’s sign-in from an explicitly chosen browser and profile name as shown in that browser. Use Default for its default profile. The desktop asks consent before reading.',
})
const decode = Schema.decodeUnknownResult(input)
const document = Schema.toJsonSchemaDocument(input)
const parameters = Type.Unsafe<typeof input.Encoded>(
  Object.assign({}, document.schema, { $defs: document.definitions }),
)

/** The model sees remedies, never OS errors or cookie values. Only a fresh user-authorized
 * invocation retries BrowserLocked. Quit means quit the named browser, not close one tab. */
export const signInMessage = (request: CopySignInRequest, outcome: CopySignInOutcome): string =>
  CopySignInOutcome.match(outcome, {
    InvalidSite: () => 'Choose one site, such as github.com. A public suffix cannot be copied.',
    NotAnswered: () =>
      'The desktop did not return this sign-in. Nothing was copied. Ask to try again when you are ready to allow it.',
    Copied: ({ cookies }) =>
      `Copied ${cookies} cookies for ${request.site}. Open the site on Vivid’s Computer to check the sign-in.`,
    BrowserLocked: ({ browser }) =>
      `Quit ${browser}, then tell me to retry copying your ${request.site} sign-in. The browser is still using its cookie file. No sign-in was copied.`,
    PermissionDenied: ({ browser }) =>
      `${browser}’s cookie store or encryption key denied access. Grant the operating-system permission, then ask to retry.`,
    KeyUnavailable: ({ browser }) =>
      `${browser}’s cookie encryption key could not be obtained on this device. No sign-in was copied. Ask the person to sign in on Vivid’s Computer.`,
    UnsupportedEncryption: ({ browser }) =>
      `${browser}’s cookie encryption cannot be imported on this device. Quitting the browser does not fix this. Ask the person to sign in on Vivid’s Computer.`,
    UnsupportedCookieScope: ({ browser }) =>
      `${browser}’s selected cookies use a partition that cannot be preserved during copying. No sign-in was copied. Ask the person to sign in on Vivid’s Computer.`,
    SourceMissing: ({ browser }) =>
      `The selected ${browser} profile was not found. Ask the person which browser and profile to use.`,
    Unreadable: ({ browser }) =>
      `${browser}’s cookies could not be read. No sign-in was copied. Do not claim the browser is locked without that result.`,
    NothingToCopy: () => `No cookies for ${request.site} were found in the selected profile.`,
    Declined: () => 'The person declined copying this sign-in. Stop.',
    NotConnected: () => 'The person’s allowed Vivid desktop app is not connected.',
    Busy: () => 'The person’s device is busy. No sign-in was copied.',
    RunRequired: () => 'This request needs the person’s active Run. No sign-in was copied.',
    Unavailable: ({ reason }) => reason,
    Rejected: () =>
      'Vivid’s Computer rejected the sign-in copy. Some cookies may have been written. Check the site before repeating it.',
    OutcomeUnknown: () =>
      'The copy receipt was lost. It may have copied cookies. Check the site before asking to repeat it.',
  })

/** Sign-ins that cannot be brought across from this browser: signing in on Vivid's own computer is
 * the way left, which the Person does in the window Vivid shows them. */
const cannotCopy = (request: CopySignInRequest) =>
  plain(
    `i can’t copy your ${request.site} sign-in from that browser. you could sign in on my computer instead.`,
  )

/**
 * What each outcome means for the Person, beside `signInMessage` for Vivid: cookies, encryption
 * keys, partitions and receipts are how the copy works, so the Person hears what did not happen
 * and the one thing they can do. A copied sign-in is not yet proof Vivid is signed in, so it says
 * nothing until the site is read.
 */
const signInMeaning = (request: CopySignInRequest, outcome: CopySignInOutcome): Plain =>
  CopySignInOutcome.match(outcome, {
    InvalidSite: () => quiet,
    Copied: () => quiet,
    NotAnswered: () =>
      plain(
        'your computer didn’t answer, so i didn’t copy anything. ask me again when you’re ready to allow it.',
      ),
    BrowserLocked: ({ browser }) =>
      plain(`quit ${browser} completely, then tell me and i’ll copy your ${request.site} sign-in.`),
    PermissionDenied: ({ browser }) =>
      plain(
        `your computer didn’t let me read ${browser}’s sign-ins. allow it when it asks, then ask me again.`,
      ),
    KeyUnavailable: () => cannotCopy(request),
    UnsupportedEncryption: () => cannotCopy(request),
    UnsupportedCookieScope: () => cannotCopy(request),
    SourceMissing: ({ browser }) =>
      plain(
        `i couldn’t find that ${browser} profile. which browser and profile do you use for ${request.site}?`,
      ),
    Unreadable: () => cannotCopy(request),
    NothingToCopy: () =>
      plain(
        `you’re not signed in to ${request.site} in that browser, so there was nothing to copy.`,
      ),
    Declined: () => quiet,
    NotConnected: () =>
      plain(
        'your computer isn’t connected to me right now. open the vivid app on it and ask me again.',
      ),
    Busy: () => quiet,
    RunRequired: () => quiet,
    Unavailable: () => plain(`i couldn’t copy your ${request.site} sign-in right now.`),
    Rejected: () =>
      plain(
        `copying your ${request.site} sign-in didn’t go through cleanly, so i haven’t tried again.`,
      ),
    OutcomeUnknown: () =>
      plain(
        `i can’t tell whether your ${request.site} sign-in copied, so i haven’t done it again.`,
      ),
  })

/** The RPC success schema cannot contain a cookie. BrowserLocked ends the turn, giving the
 * Person time to quit before another request, rather than retrying against the same lock. */
const program = Effect.fn('ComputerTool.copySignIn')(function* (request: CopySignInRequest) {
  const outcome = yield* (yield* Scope).client.CopySignIn(request)
  const message = signInMessage(request, outcome)
  return {
    output: CopySignInOutcome.guards.Copied(outcome)
      ? { ok: true, site: request.site, outcome, message }
      : { ...refused(message, signInMeaning(request, outcome)), site: request.site, outcome },
    terminate: CopySignInOutcome.isAnyOf([
      'BrowserLocked',
      'PermissionDenied',
      'KeyUnavailable',
      'NotAnswered',
      'Declined',
    ])(outcome),
  }
})

/** Computer tool input is decoded once and cancellation reaches the attributed RPC runner.
 * This adapter has no browser-closing capability. */
export function signInModelTool(runTool: RunTool) {
  return durableTool({
    name: Tool.copy_signin,
    description:
      'Copy the person’s sign-in for one site to Vivid’s Computer when they ask. Choose Chrome or Helium and the profile name shown in that browser, or Default. Never copy in the background or switch sources silently. BrowserLocked means ask them to quit that browser, end this turn, and wait for their request to retry. Never close their browser yourself. Copied is a cookie transfer receipt; read the site afterward to verify login.',
    parameters,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native runtime tool input is untrusted; the shared schema owns ingress.
    execute(value, _api, context) {
      return executionResult(
        executeCall(
          (signal) => {
            const parsed = decode(value)
            if (Result.isFailure(parsed))
              return Promise.resolve(
                pictureResult(
                  {
                    output: refused('The sign-in copy request is invalid.', quiet),
                    terminate: false,
                  },
                  Option.none(),
                ),
              )
            return runTool(program(parsed.success), {
              signal: signal === undefined ? new AbortController().signal : signal,
              tool: 'copy_signin',
            }).then((result) => pictureResult(result, Option.none()))
          },
          context,
          { name: 'copy_signin' },
        ).then((result) => toolResult('copy_signin', result)),
        context,
      )
    },
  })
}
