import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { DeviceLink, type VividDeviceBridge } from './device.ts'
import { ServerAddress, ServerSettings, ServerChoice } from './settings.ts'
import {
  BrowserState,
  PagesRequest,
  PagesResponse,
  PageDownloadRefused,
  type VividPagesBridge,
} from './pages.ts'

/** The one renderer global exposed by the sandboxed preload. */
export const BRIDGE_NAMESPACE = 'vivid'
/** Main and preload use one invoke channel so the tagged request union is the channel allowlist. */
export const BRIDGE_INVOKE_CHANNEL = 'vivid:desktop:invoke'
/** Main and preload use one event channel so every event is decoded by the same closed union. */
export const BRIDGE_EVENT_CHANNEL = 'vivid:desktop:event'

const NonEmptyString = Schema.String.check(
  Schema.isNonEmpty({ message: 'Expected a non-empty string' }),
)

export const ColorSchemePreference = Schema.Literals(['system', 'light', 'dark'] as const)
export type ColorSchemePreference = typeof ColorSchemePreference.Type

export const ResolvedColorScheme = Schema.Literals(['light', 'dark'] as const)
export type ResolvedColorScheme = typeof ResolvedColorScheme.Type

export const DesktopPlatform = Schema.Literals(['darwin', 'win32', 'linux', 'other'] as const)
export type DesktopPlatform = typeof DesktopPlatform.Type

/** Stable application metadata that is safe for the renderer to receive. */
export const AppInfo = Schema.Struct({
  appVersion: NonEmptyString,
  electronVersion: NonEmptyString,
  platform: DesktopPlatform,
})
export interface AppInfo extends Schema.Schema.Type<typeof AppInfo> {}

/** The native preference and its currently resolved paint scheme travel together. */
export const ColorSchemeState = Schema.Struct({
  preference: ColorSchemePreference,
  resolved: ResolvedColorScheme,
})
export interface ColorSchemeState extends Schema.Schema.Type<typeof ColorSchemeState> {}

/** Only browser-safe destinations may be handed to the operating system. */
export const ExternalUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === ''
      )
    },
    { message: 'Expected an HTTP(S) external URL' },
  ),
)

/** Every renderer-to-main capability and argument is schema-decoded in main. */
export const BridgeRequest = Schema.TaggedUnion({
  GetAppVersion: {},
  GetServer: {},
  ChooseServer: { origin: ServerAddress },
  ForgetServer: {},
  OpenExternal: { url: ExternalUrl },
  Pages: { request: PagesRequest },
  /** What this computer is to Vivid, as the app last heard it. */
  GetDeviceLink: {},
  /** The Person changed this computer's access: ask the server again now. */
  RefreshDeviceLink: {},
})
export type BridgeRequest = typeof BridgeRequest.Type

/** Results name the operation they answer; persistence failure is never reported as Chosen. */
export const BridgeResponse = Schema.TaggedUnion({
  AppVersion: { value: NonEmptyString },
  Server: { value: ServerSettings },
  ServerChoice: { value: ServerChoice },
  Forgotten: {},
  ExternalOpened: {},
  SettingsSaveFailed: {},
  ExternalOpenFailed: {},
  Pages: { value: PagesResponse },
  DeviceLink: { value: DeviceLink },
})
export type BridgeResponse = typeof BridgeResponse.Type

/** Push messages use a separate closed union because they have no pending request. */
export const BridgeEvent = Schema.TaggedUnion({
  ColorSchemeChanged: { value: ColorSchemeState },
  PagesChanged: { value: BrowserState },
  PageDownloadRefused: { value: PageDownloadRefused },
})
export type BridgeEvent = typeof BridgeEvent.Type

/** Invalid IPC never reaches a handler and never gets represented as a raw Error. */
export class InvalidBridgeMessage extends Schema.TaggedError<InvalidBridgeMessage>()(
  'InvalidBridgeMessage',
  {
    direction: Schema.Literals(['request', 'response', 'event'] as const),
  },
  { title: 'Invalid desktop bridge message' },
) {}

const decodeRequest = Schema.decodeUnknownEffect(BridgeRequest, { onExcessProperty: 'error' })
const decodeResponse = Schema.decodeUnknownEffect(BridgeResponse)
const decodeEventResult = Schema.decodeUnknownResult(BridgeEvent)
const encodeRequest = Schema.encodeEffect(BridgeRequest)
const encodeResponse = Schema.encodeEffect(BridgeResponse)
const encodeEvent = Schema.encodeSync(BridgeEvent)

/** Decode one untrusted renderer request exactly once at the main-process ingress. */
export const decodeBridgeRequest = (payload: typeof Schema.Unknown.Type) =>
  decodeRequest(payload).pipe(
    Effect.mapError(() => new InvalidBridgeMessage({ direction: 'request' })),
  )

/** Decode one untrusted main-process response exactly once at the preload ingress. */
export const decodeBridgeResponse = (payload: typeof Schema.Unknown.Type) =>
  decodeResponse(payload).pipe(
    Effect.mapError(() => new InvalidBridgeMessage({ direction: 'response' })),
  )

/** Decode a pushed event without throwing inside Electron's synchronous event callback. */
export const decodeBridgeEventResult = decodeEventResult

/** Encode a trusted request before crossing Electron's structured-clone boundary. */
export const encodeBridgeRequest = (request: BridgeRequest) =>
  encodeRequest(request).pipe(
    Effect.mapError(() => new InvalidBridgeMessage({ direction: 'request' })),
  )

/** Encode a trusted response before returning from Electron's invoke callback. */
export const encodeBridgeResponse = (response: BridgeResponse) =>
  encodeResponse(response).pipe(
    Effect.mapError(() => new InvalidBridgeMessage({ direction: 'response' })),
  )

/** Encode a trusted event before sending it to the isolated renderer. */
export const encodeBridgeEvent = (event: BridgeEvent) => encodeEvent(event)

/** The local chooser and web shell import this type without Electron or filesystem authority. */
export interface VividDesktopBridge {
  readonly pages: VividPagesBridge
  readonly device: VividDeviceBridge
  readonly server: {
    readonly get: () => Promise<ServerSettings>
    readonly choose: (origin: string) => Promise<ServerChoice>
    readonly forget: () => Promise<void>
  }
  readonly getAppVersion: () => Promise<string>
  readonly openExternal: (url: string) => Promise<void>
}

export { ServerSettings, ServerChoice } from './settings.ts'
export { DeviceLink, type VividDeviceBridge } from './device.ts'
export {
  BrowserState,
  Page,
  ShowingTab,
  UsedTab,
  PageLoadFailure,
  PageFavicon,
  Tab,
  PageInput,
  PageRectangle,
  PagePlacement,
  PageDownloadRefused,
  PageMissing,
  PageAddressRefused,
  PageUnavailable,
  PageLimitReached,
  PagePositionInvalid,
  PageReopenEmpty,
  PageStorageClearFailed,
  PageCacheClearFailed,
  type VividPagesBridge,
  type PageOption,
} from './pages.ts'

/** Selected app documents get page authority; chooser-only server settings remain separate. */
export type VividAppBridge = Pick<VividDesktopBridge, 'getAppVersion' | 'pages' | 'device'>
