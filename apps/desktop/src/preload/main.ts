import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { contextBridge, ipcRenderer } from 'electron'
import {
  BRIDGE_NAMESPACE,
  BRIDGE_INVOKE_CHANNEL,
  BridgeRequest,
  BridgeResponse,
  type VividDesktopBridge,
  decodeBridgeResponse,
  encodeBridgeRequest,
} from '../shared/bridge.ts'
import { SettingsSaveFailed } from '../shared/settings.ts'

/** Transport rejection carries no renderer-supplied data into logs or error messages. */
class BridgeTransportFailed extends Schema.TaggedError<BridgeTransportFailed>()(
  'BridgeTransportFailed',
  {},
  { title: 'Desktop bridge transport failed' },
) {}
/** A mismatched response indicates a main/preload protocol defect, never an invented success. */
class UnexpectedBridgeResponse extends Schema.TaggedError<UnexpectedBridgeResponse>()(
  'UnexpectedBridgeResponse',
  {},
  { title: 'Desktop bridge response did not match its request' },
) {}
/** External browsing failure is distinct from server persistence failure. */
class ExternalOpenFailed extends Schema.TaggedError<ExternalOpenFailed>()(
  'ExternalOpenFailed',
  {},
  { title: 'Desktop external URL could not be opened' },
) {}

const decodeOrigin = Schema.decodeUnknownEffect(BridgeRequest.cases.ChooseServer.fields.origin)
const decodeExternal = Schema.decodeUnknownEffect(BridgeRequest.cases.OpenExternal.fields.url)

/** Only this private adapter can invoke IPC; renderer code never receives arbitrary channels. */
const invoke = Effect.fn('DesktopPreload.invoke')(function* (request: BridgeRequest) {
  const payload = yield* encodeBridgeRequest(request)
  const response = yield* Effect.tryPromise({
    try: () => ipcRenderer.invoke(BRIDGE_INVOKE_CHANNEL, payload),
    catch: () => new BridgeTransportFailed({}),
  })
  const decoded = yield* decodeBridgeResponse(response)
  if (BridgeResponse.guards.SettingsSaveFailed(decoded)) return yield* new SettingsSaveFailed({})
  if (BridgeResponse.guards.ExternalOpenFailed(decoded)) return yield* new ExternalOpenFailed({})
  return decoded
})

/** Get returns truthful first-launch state, with no default server embedded in preload. */
const getServer = Effect.fn('DesktopPreload.getServer')(function* () {
  const response = yield* invoke(BridgeRequest.cases.GetServer.make({}))
  if (BridgeResponse.guards.Server(response)) return response.value
  return yield* new UnexpectedBridgeResponse({})
})

/** Preload checks its input too; main independently decodes every request at the authority seam. */
const chooseServer = Effect.fn('DesktopPreload.chooseServer')(function* (value: string) {
  const origin = yield* decodeOrigin(value)
  const response = yield* invoke(BridgeRequest.cases.ChooseServer.make({ origin }))
  if (BridgeResponse.guards.ServerChoice(response)) return response.value
  return yield* new UnexpectedBridgeResponse({})
})

/** A successful forget response means the server was durably removed. */
const forgetServer = Effect.fn('DesktopPreload.forgetServer')(function* () {
  const response = yield* invoke(BridgeRequest.cases.ForgetServer.make({}))
  if (BridgeResponse.guards.Forgotten(response)) return undefined
  return yield* new UnexpectedBridgeResponse({})
})

/** Renderer callers receive the application version without Node runtime metadata or access. */
const getAppVersion = Effect.fn('DesktopPreload.getAppVersion')(function* () {
  const response = yield* invoke(BridgeRequest.cases.GetAppVersion.make({}))
  if (BridgeResponse.guards.AppVersion(response)) return response.value
  return yield* new UnexpectedBridgeResponse({})
})

/** Only schema-approved HTTP(S) destinations can open in the Person's system browser. */
const openExternal = Effect.fn('DesktopPreload.openExternal')(function* (value: string) {
  const url = yield* decodeExternal(value)
  const response = yield* invoke(BridgeRequest.cases.OpenExternal.make({ url }))
  if (BridgeResponse.guards.ExternalOpened(response)) return undefined
  return yield* new UnexpectedBridgeResponse({})
})

/** Promise terminals live only at Electron's isolated context bridge. */
const bridge: VividDesktopBridge = {
  server: {
    get: () => Effect.runPromise(getServer()),
    choose: (origin) => Effect.runPromise(chooseServer(origin)),
    forget: () => Effect.runPromise(forgetServer()),
  },
  getAppVersion: () => Effect.runPromise(getAppVersion()),
  openExternal: (url) => Effect.runPromise(openExternal(url)),
}
contextBridge.exposeInMainWorld(BRIDGE_NAMESPACE, bridge)
