import * as Effect from 'effect/Effect'
import type * as HttpClient from 'effect/http/HttpClient'
import type * as Schema from 'effect/Schema'
import {
  BridgeRequest,
  BridgeResponse,
  InvalidBridgeMessage,
  decodeBridgeRequest,
  encodeBridgeResponse,
} from '../shared/bridge.ts'
import type { DeviceLink } from '../shared/device.ts'
import { ServerChoice, type ServerSettings, type ServerAddress } from '../shared/settings.ts'
import type { DesktopSettings } from './settings.ts'
import type { GoogleSignIn } from './signin.ts'
import { chooseServer } from './server.ts'
import { type PagesRequest, PagesResponse, type PagesFailure } from '../shared/pages.ts'

/**
 * Main supplies settings, version metadata, external browsing, Google sign-in and the isolated
 * Browser authority.
 */
export interface BridgeHandlers {
  readonly pages: (request: PagesRequest) => Effect.Effect<PagesResponse, PagesFailure>
  readonly getAppVersion: () => string
  /** This computer's link to Vivid: what it is now, and a nudge to ask the server again. */
  readonly device: { readonly state: () => DeviceLink; readonly wake: () => void }
  readonly settings: DesktopSettings['Service']
  readonly onServerChanged: (value: ServerSettings) => void
  readonly openExternal: (
    url: string,
  ) => Effect.Effect<void, { readonly _tag: 'ExternalUrlOpenFailed' }>
  /** The one Google sign-in attempt the shell runs through the system browser (`signin.ts`). */
  readonly signIn: GoogleSignIn
}

/** Choosing a server publishes navigation only after its probe and durable write both succeed. */
const choose = Effect.fn('DesktopBridge.choose')(function* (
  origin: ServerAddress,
  handlers: BridgeHandlers,
) {
  const result = yield* chooseServer(origin, handlers.settings)
  if (ServerChoice.guards.Chosen(result)) handlers.onServerChanged(yield* handlers.settings.get)
  return BridgeResponse.cases.ServerChoice.make({ value: result })
})

/** Forgetting removes network authority durably before the caller returns to the chooser. */
const forget = Effect.fn('DesktopBridge.forget')(function* (handlers: BridgeHandlers) {
  const state = yield* handlers.settings.forget
  handlers.onServerChanged(state)
  return BridgeResponse.cases.Forgotten.make({})
})

/** Decode untrusted IPC once and exhaustively dispatch through the same public contract as preload. */
export const handleBridgeRequest = Effect.fn('DesktopBridge.handleRequest')(function* (
  payload: typeof Schema.Unknown.Type,
  handlers: BridgeHandlers,
  authorize: (request: BridgeRequest) => boolean,
) {
  const request = yield* decodeBridgeRequest(payload)
  if (!authorize(request)) return yield* new InvalidBridgeMessage({ direction: 'request' })
  const response = yield* BridgeRequest.match<
    Effect.Effect<BridgeResponse, never, HttpClient.HttpClient>
  >(request, {
    GetAppVersion: () =>
      Effect.succeed(BridgeResponse.cases.AppVersion.make({ value: handlers.getAppVersion() })),
    GetServer: () =>
      handlers.settings.get.pipe(
        Effect.map((value) => BridgeResponse.cases.Server.make({ value })),
      ),
    ChooseServer: ({ origin }) =>
      choose(origin, handlers).pipe(
        Effect.catchTag('SettingsSaveFailed', () =>
          Effect.succeed(BridgeResponse.cases.SettingsSaveFailed.make({})),
        ),
      ),
    ForgetServer: () =>
      forget(handlers).pipe(
        Effect.catchTag('SettingsSaveFailed', () =>
          Effect.succeed(BridgeResponse.cases.SettingsSaveFailed.make({})),
        ),
      ),
    OpenExternal: ({ url }) =>
      handlers.openExternal(url).pipe(
        Effect.as(BridgeResponse.cases.ExternalOpened.make({})),
        Effect.catchTag('ExternalUrlOpenFailed', () =>
          Effect.succeed(BridgeResponse.cases.ExternalOpenFailed.make({})),
        ),
      ),
    // None of the four carries an argument: the address the browser is sent to is built in main
    // from the saved server, and `authorize` has already refused every sender but that server's
    // own document. Beginning and reopening answer alike, with whether the browser opened.
    BeginGoogleSignIn: () =>
      handlers.signIn.begin.pipe(
        Effect.map((browser) => BridgeResponse.cases.GoogleSignInBegun.make({ browser })),
      ),
    ReopenGoogleSignIn: () =>
      handlers.signIn.reopen.pipe(
        Effect.map((browser) => BridgeResponse.cases.GoogleSignInBegun.make({ browser })),
      ),
    // This one stays pending for as long as the attempt does, up to its five minutes.
    AwaitGoogleSignIn: () =>
      handlers.signIn.ended.pipe(
        Effect.map((value) => BridgeResponse.cases.GoogleSignInEnded.make({ value })),
      ),
    CancelGoogleSignIn: () =>
      handlers.signIn.cancel.pipe(Effect.as(BridgeResponse.cases.GoogleSignInCancelled.make({}))),
    GetDeviceLink: () =>
      Effect.sync(() => BridgeResponse.cases.DeviceLink.make({ value: handlers.device.state() })),
    RefreshDeviceLink: () =>
      Effect.sync(() => {
        handlers.device.wake()
        return BridgeResponse.cases.DeviceLink.make({ value: handlers.device.state() })
      }),
    Pages: ({ request: pagesRequest }) =>
      handlers.pages(pagesRequest).pipe(
        Effect.catchTags({
          PageMissing: (reason) => Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
          PageAddressRefused: (reason) =>
            Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
          PageUnavailable: (reason) =>
            Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
          PageLimitReached: (reason) =>
            Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
          PagePositionInvalid: (reason) =>
            Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
          PageReopenEmpty: (reason) =>
            Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
          PageStorageClearFailed: (reason) =>
            Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
          PageCacheClearFailed: (reason) =>
            Effect.succeed(PagesResponse.cases.Rejected.make({ reason })),
        }),
        Effect.map((value) => BridgeResponse.cases.Pages.make({ value })),
      ),
  })
  return yield* encodeBridgeResponse(response)
})
