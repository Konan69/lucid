import * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import {
  BridgeRequest,
  BridgeResponse,
  decodeBridgeRequest,
  encodeBridgeResponse,
} from '../shared/bridge.ts'
import { ServerChoice, type ServerSettings, type ServerAddress } from '../shared/settings.ts'
import type { DesktopSettings } from './settings.ts'
import { chooseServer } from './server.ts'

/** Persistence, version metadata, and external browsing are the complete bridge authorities. */
export interface BridgeHandlers {
  readonly getAppVersion: () => string
  readonly settings: DesktopSettings['Service']
  readonly onServerChanged: (value: ServerSettings) => void
  readonly openExternal: (
    url: string,
  ) => Effect.Effect<void, { readonly _tag: 'ExternalUrlOpenFailed' }>
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
) {
  const request = yield* decodeBridgeRequest(payload)
  const response = yield* BridgeRequest.match<Effect.Effect<BridgeResponse>>(request, {
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
  })
  return yield* encodeBridgeResponse(response)
})
