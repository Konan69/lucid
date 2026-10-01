import * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import { ipcMain, type WebContents } from 'electron'
import {
  BRIDGE_EVENT_CHANNEL,
  BRIDGE_INVOKE_CHANNEL,
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  type AppInfo,
  type ColorSchemeState,
  type InvalidBridgeMessage,
  decodeBridgeRequest,
  encodeBridgeEvent,
  encodeBridgeResponse,
} from '../shared/bridge.ts'
import type { DesktopSettings } from './settings.ts'
import type { ServerSettings } from '../shared/settings.ts'

/** Main-process capabilities exposed through the closed bridge request union. */
export interface BridgeHandlers {
  readonly getAppInfo: () => AppInfo
  readonly getColorSchemeState: () => ColorSchemeState
  readonly settings: DesktopSettings['Service']
  readonly onServerSettingsChanged: (value: ServerSettings) => void
}

/** Electron owns Promise execution; main.ts supplies the one Effect runtime boundary. */
export interface BridgeRuntime {
  readonly run: (
    program: Effect.Effect<typeof BridgeResponse.Encoded, InvalidBridgeMessage>,
  ) => Promise<typeof BridgeResponse.Encoded>
}

/** Decode, dispatch exhaustively, then encode one IPC invocation. */
const handleBridgeRequest = Effect.fn('DesktopBridge.handleRequest')(function* (
  payload: typeof Schema.Unknown.Type,
  handlers: BridgeHandlers,
) {
  const request = yield* decodeBridgeRequest(payload)
  const response = yield* BridgeRequest.match<Effect.Effect<BridgeResponse>>(request, {
    GetAppInfo: () =>
      Effect.succeed(BridgeResponse.cases.AppInfo.make({ value: handlers.getAppInfo() })),
    GetColorSchemeState: () =>
      Effect.succeed(
        BridgeResponse.cases.ColorSchemeState.make({ value: handlers.getColorSchemeState() }),
      ),
    GetServerSettings: () =>
      handlers.settings.get.pipe(
        Effect.map((value) => BridgeResponse.cases.ServerSettings.make({ value })),
      ),
    SetServerAddress: ({ serverAddress }) =>
      handlers.settings.set(serverAddress).pipe(
        Effect.tap((value) => Effect.sync(() => handlers.onServerSettingsChanged(value))),
        Effect.map((value) => BridgeResponse.cases.ServerSettings.make({ value })),
        Effect.catchTag('SettingsSaveFailed', () =>
          Effect.succeed(BridgeResponse.cases.SettingsSaveFailed.make({})),
        ),
      ),
  })
  return yield* encodeBridgeResponse(response)
})

/**
 * Register the sole invoke channel. The Electron callback remains a narrow framework adapter: it
 * forwards the untrusted payload into the Effect program and delegates execution to main.ts.
 */
export function registerBridge(handlers: BridgeHandlers, runtime: BridgeRuntime): void {
  ipcMain.handle(BRIDGE_INVOKE_CHANNEL, (_event, payload) =>
    runtime.run(handleBridgeRequest(payload, handlers)),
  )
}

/** Encode a trusted tagged event before Electron copies it into the isolated renderer. */
export function sendColorSchemeChanged(target: WebContents, value: ColorSchemeState): void {
  const event = BridgeEvent.cases.ColorSchemeChanged.make({ value })
  target.send(BRIDGE_EVENT_CHANNEL, encodeBridgeEvent(event))
}
