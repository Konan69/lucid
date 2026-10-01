import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  BRIDGE_EVENT_CHANNEL,
  BRIDGE_INVOKE_CHANNEL,
  BRIDGE_NAMESPACE,
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  type AppInfo,
  type ColorSchemeState,
  type VividDesktopBridge,
  decodeBridgeEventResult,
  decodeBridgeResponse,
  encodeBridgeRequest,
} from '../shared/bridge.ts'
import { ServerAddress, SettingsSaveFailed } from '../shared/settings.ts'

const decodeServerAddress = Schema.decodeUnknownEffect(ServerAddress)

/** The Electron transport rejected a request before a typed response arrived. */
class BridgeTransportFailed extends Schema.TaggedError<BridgeTransportFailed>()(
  'BridgeTransportFailed',
  { operation: Schema.String },
  { title: 'Desktop bridge transport failed' },
) {}

/** A valid response answered a different request, which indicates a main/preload protocol defect. */
class UnexpectedBridgeResponse extends Schema.TaggedError<UnexpectedBridgeResponse>()(
  'UnexpectedBridgeResponse',
  { operation: Schema.String },
  { title: 'Desktop bridge response did not match its request' },
) {}

/** Encode, invoke, and decode one request while the raw Promise remains inside this adapter. */
const invoke = Effect.fn('DesktopPreload.invoke')(function* (request: BridgeRequest) {
  const payload = yield* encodeBridgeRequest(request)
  const response = yield* Effect.tryPromise({
    try: () => ipcRenderer.invoke(BRIDGE_INVOKE_CHANNEL, payload),
    catch: () => new BridgeTransportFailed({ operation: 'invoke' }),
  })
  return yield* decodeBridgeResponse(response)
})

/** Require the response variant paired with GetAppInfo. */
const getAppInfo = Effect.fn('DesktopPreload.getAppInfo')(function* () {
  const response = yield* invoke(BridgeRequest.cases.GetAppInfo.make({}))
  if (BridgeResponse.guards.AppInfo(response)) return response.value
  return yield* new UnexpectedBridgeResponse({ operation: 'getAppInfo' })
})

/** Require the response variant paired with GetColorSchemeState. */
const getColorSchemeState = Effect.fn('DesktopPreload.getColorSchemeState')(function* () {
  const response = yield* invoke(BridgeRequest.cases.GetColorSchemeState.make({}))
  if (BridgeResponse.guards.ColorSchemeState(response)) return response.value
  return yield* new UnexpectedBridgeResponse({ operation: 'getColorSchemeState' })
})

/** First-launch state lets the existing renderer own address selection without filesystem access. */
const getServerSettings = Effect.fn('DesktopPreload.getServerSettings')(function* () {
  const response = yield* invoke(BridgeRequest.cases.GetServerSettings.make({}))
  if (BridgeResponse.guards.ServerSettings(response)) return response.value
  return yield* new UnexpectedBridgeResponse({ operation: 'getServerSettings' })
})

/** Validate before IPC; main persists the selection before a subsequent renderer reload. */
const setServerAddress = Effect.fn('DesktopPreload.setServerAddress')(function* (address: string) {
  const serverAddress = yield* decodeServerAddress(address)
  const response = yield* invoke(BridgeRequest.cases.SetServerAddress.make({ serverAddress }))
  if (BridgeResponse.guards.ServerSettings(response)) return response.value
  if (BridgeResponse.guards.SettingsSaveFailed(response)) return yield* new SettingsSaveFailed({})
  return yield* new UnexpectedBridgeResponse({ operation: 'setServerAddress' })
})

/** Decode pushed messages before dispatching them to renderer listeners. */
function subscribeToColorScheme(listener: (state: ColorSchemeState) => void): () => void {
  const receive = (_event: IpcRendererEvent, payload: typeof Schema.Unknown.Type): void => {
    Result.match(decodeBridgeEventResult(payload), {
      onFailure: () => undefined,
      onSuccess: (event) =>
        BridgeEvent.match(event, {
          ColorSchemeChanged: ({ value }) => listener(value),
        }),
    })
  }
  ipcRenderer.on(BRIDGE_EVENT_CHANNEL, receive)
  return () => {
    ipcRenderer.off(BRIDGE_EVENT_CHANNEL, receive)
  }
}

/**
 * Electron requires Promise-returning methods at the context bridge. These are the preload's only
 * Effect terminals; all parsing, transport failures, and response matching stay inside Effects.
 */
const bridge: VividDesktopBridge = {
  getAppInfo: (): Promise<AppInfo> => Effect.runPromise(getAppInfo()),
  getColorSchemeState: (): Promise<ColorSchemeState> => Effect.runPromise(getColorSchemeState()),
  getServerSettings: () => Effect.runPromise(getServerSettings()),
  setServerAddress: (address) => Effect.runPromise(setServerAddress(address)),
  onColorSchemeChanged: subscribeToColorScheme,
}

contextBridge.exposeInMainWorld(BRIDGE_NAMESPACE, bridge)
