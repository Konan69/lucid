import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { contextBridge, ipcRenderer } from 'electron'
import {
  BRIDGE_NAMESPACE,
  BRIDGE_INVOKE_CHANNEL,
  BRIDGE_EVENT_CHANNEL,
  REPORTING_ARGUMENT,
  BridgeRequest,
  BridgeResponse,
  BridgeEvent,
  type ColorSchemePreference,
  DesktopNotification,
  type VividDesktopBridge,
  decodeBridgeResponse,
  decodeBridgeEventResult,
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
    GoogleSignInBegun: answered,
    GoogleSignInEnded: answered,
    GoogleSignInCancelled: answered,
    ColorSchemeShown: answered,
    NotificationShown: answered,
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
 * Starts a Google sign-in, or opens the browser again for the one in progress. Both carry no
 * argument and answer alike: whether the system browser opened. Main builds the address from the
 * server it has saved, so nothing a document says can send the browser anywhere.
 */
const signInBrowser = Effect.fn('DesktopPreload.signInBrowser')(function* (
  request:
    | typeof BridgeRequest.cases.BeginGoogleSignIn.Type
    | typeof BridgeRequest.cases.ReopenGoogleSignIn.Type,
) {
  const response = yield* invoke(request)
  if (BridgeResponse.guards.GoogleSignInBegun(response)) return response.browser
  return yield* new UnexpectedBridgeResponse({})
})

/**
 * Waits for the sign-in in progress to end. The invoke stays pending for as long as the attempt
 * does. A `Granted` ending crosses here once, as plain text, for the document to trade.
 */
const signInEnded = Effect.fn('DesktopPreload.signInEnded')(function* () {
  const response = yield* invoke(BridgeRequest.cases.AwaitGoogleSignIn.make({}))
  if (BridgeResponse.guards.GoogleSignInEnded(response)) return response.value
  return yield* new UnexpectedBridgeResponse({})
})

/** Stops the sign-in in progress; a pending `ended` then resolves `Cancelled`. */
const cancelSignIn = Effect.fn('DesktopPreload.cancelSignIn')(function* () {
  const response = yield* invoke(BridgeRequest.cases.CancelGoogleSignIn.make({}))
  if (BridgeResponse.guards.GoogleSignInCancelled(response)) return undefined
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

/** Hands the shell the look the Person chose; there is nothing to read back. */
const showColorScheme = Effect.fn('DesktopPreload.showColorScheme')(function* (
  preference: ColorSchemePreference,
) {
  const response = yield* invoke(BridgeRequest.cases.ShowColorScheme.make({ preference }))
  if (BridgeResponse.guards.ColorSchemeShown(response)) return undefined
  return yield* new UnexpectedBridgeResponse({})
})

const decodeNotification = Schema.decodeUnknownEffect(DesktopNotification)

/** Asks the shell to show a notification; main decides whether its window is in front. */
const showNotification = Effect.fn('DesktopPreload.showNotification')(function* (
  value: DesktopNotification,
) {
  const notification = yield* decodeNotification(value)
  const response = yield* invoke(BridgeRequest.cases.ShowNotification.make({ notification }))
  if (BridgeResponse.guards.NotificationShown(response)) return undefined
  return yield* new UnexpectedBridgeResponse({})
})

/** Who hears a pressed notification. The page subscribes once, as it loads. */
const openedListeners = new Set<(opened: { readonly threadId: string | null }) => void>()

// One decoded adapter for the event channel's notification events, as `pages.ts` has its own.
ipcRenderer.on(BRIDGE_EVENT_CHANNEL, (_event, payload) => {
  const result = decodeBridgeEventResult(payload)
  if (Result.isFailure(result) || !BridgeEvent.guards.NotificationOpened(result.success)) return
  const opened = { threadId: result.success.threadId }
  for (const listener of openedListeners) listener(opened)
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
  signIn: {
    begin: () => Effect.runPromise(signInBrowser(BridgeRequest.cases.BeginGoogleSignIn.make({}))),
    reopen: () => Effect.runPromise(signInBrowser(BridgeRequest.cases.ReopenGoogleSignIn.make({}))),
    ended: () => Effect.runPromise(signInEnded()),
    cancel: () => Effect.runPromise(cancelSignIn()),
  },
  colorScheme: { show: (preference) => Effect.runPromise(showColorScheme(preference)) },
  notifications: {
    show: (notification) => Effect.runPromise(showNotification(notification)),
    onOpened: (listener) => {
      openedListeners.add(listener)
      return () => {
        openedListeners.delete(listener)
      }
    },
  },
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
        signIn: bridge.signIn,
        colorScheme: bridge.colorScheme,
        notifications: bridge.notifications,
      },
)
