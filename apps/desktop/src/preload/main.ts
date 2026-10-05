import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { contextBridge, ipcRenderer } from 'electron'
import {
  BRIDGE_NAMESPACE,
  BRIDGE_INVOKE_CHANNEL,
  REPORTING_ARGUMENT,
  BridgeRequest,
  BridgeResponse,
  type VividDesktopBridge,
  decodeBridgeResponse,
  encodeBridgeRequest,
} from '../shared/bridge.ts'
import { SettingsSaveFailed } from '../shared/settings.ts'
import { createPagesBridge } from './pages.ts'

/** The sandbox has browser location; this narrow view keeps DOM and Node authority out of the bridge contract. */
declare const window: {
  readonly location: { readonly protocol: string; readonly pathname: string }
}

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

/** A response that answers its request. The two failure responses are errors, never answers. */
type Answer = Exclude<
  BridgeResponse,
  { readonly _tag: 'SettingsSaveFailed' | 'ExternalOpenFailed' }
>
/** One declared result for every case, so the failures and the answers unify into one Effect. */
type Outcome = Effect.Effect<Answer, SettingsSaveFailed | ExternalOpenFailed>
const answered = (answer: Answer): Outcome => Effect.succeed(answer)

/** Only this private adapter can invoke IPC; renderer code never receives arbitrary channels. */
const invoke = Effect.fn('DesktopPreload.invoke')(function* (request: BridgeRequest) {
  const payload = yield* encodeBridgeRequest(request)
  const response = yield* Effect.tryPromise({
    try: () => ipcRenderer.invoke(BRIDGE_INVOKE_CHANNEL, payload),
    catch: () => new BridgeTransportFailed({}),
  })
  const decoded = yield* decodeBridgeResponse(response)
  // Every response is a named case: the two failures leave through the error channel, and a new
  // response kind fails to typecheck here until it is placed on one side or the other.
  return yield* BridgeResponse.match(decoded, {
    SettingsSaveFailed: (): Outcome => Effect.fail(new SettingsSaveFailed({})),
    ExternalOpenFailed: (): Outcome => Effect.fail(new ExternalOpenFailed({})),
    AppVersion: answered,
    Server: answered,
    ServerChoice: answered,
    Forgotten: answered,
    ExternalOpened: answered,
    Pages: answered,
    DeviceLink: answered,
  })
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

/**
 * Sends the approval page for a sign-in code to the system browser. Preload checks only that it
 * is a web address; whether it is the selected server's approval page is main's decision, made
 * against the server it has saved, which a document cannot change.
 */
const openApproval = Effect.fn('DesktopPreload.openApproval')(function* (value: string) {
  const address = yield* decodeExternal(value)
  const response = yield* invoke(BridgeRequest.cases.OpenApproval.make({ address }))
  if (BridgeResponse.guards.ExternalOpened(response)) return undefined
  return yield* new UnexpectedBridgeResponse({})
})

/** What this computer is to Vivid. `refresh` also asks the server again, after a decision. */
const deviceLink = Effect.fn('DesktopPreload.deviceLink')(function* (
  request:
    | typeof BridgeRequest.cases.GetDeviceLink.Type
    | typeof BridgeRequest.cases.RefreshDeviceLink.Type,
) {
  const response = yield* invoke(request)
  if (BridgeResponse.guards.DeviceLink(response)) return response.value
  return yield* new UnexpectedBridgeResponse({})
})

/** Promise terminals live only at Electron's isolated context bridge. */
const bridge: VividDesktopBridge = {
  // Main says so by an argument on this process (`REPORTING_ARGUMENT`), read here once.
  reporting: process.argv.includes(REPORTING_ARGUMENT),
  pages: createPagesBridge(invoke, (program) => Effect.runPromise(program)),
  device: {
    get: () => Effect.runPromise(deviceLink(BridgeRequest.cases.GetDeviceLink.make({}))),
    refresh: () => Effect.runPromise(deviceLink(BridgeRequest.cases.RefreshDeviceLink.make({}))),
  },
  server: {
    get: () => Effect.runPromise(getServer()),
    choose: (origin) => Effect.runPromise(chooseServer(origin)),
    forget: () => Effect.runPromise(forgetServer()),
  },
  getAppVersion: () => Effect.runPromise(getAppVersion()),
  openExternal: (url) => Effect.runPromise(openExternal(url)),
  openApproval: (address) => Effect.runPromise(openApproval(address)),
}
// Preload limits the visible API; main independently checks the actual sender frame on every call.
const chooserDocument =
  window.location.protocol === 'file:' && window.location.pathname.endsWith('/chooser.html')
contextBridge.exposeInMainWorld(
  BRIDGE_NAMESPACE,
  chooserDocument
    ? bridge
    : {
        reporting: bridge.reporting,
        getAppVersion: bridge.getAppVersion,
        pages: bridge.pages,
        device: bridge.device,
        openApproval: bridge.openApproval,
      },
)
