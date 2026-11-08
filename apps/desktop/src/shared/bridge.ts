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
/**
 * The argument main adds to a window's process when it is sending error reports, and preload
 * looks for. Electron appends `webPreferences.additionalArguments` to `process.argv` of the
 * window's process "for passing small bits of data down to renderer process preload scripts"
 * (electron.d.ts), which is the only thing a sandboxed preload can read before the page runs
 * without asking main and waiting.
 */
export const REPORTING_ARGUMENT = '--vivid-reporting'
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

/**
 * Whether the system browser opened for a Google sign-in. A browser that did not open is not the
 * end of the attempt: the shell is still listening, and the window offers to open it again.
 */
export const SignInBrowser = Schema.Literals(['opened', 'unopened'] as const)
export type SignInBrowser = typeof SignInBrowser.Type

/**
 * How one Google sign-in ended, as the shell tells the window that asked.
 *
 * - `Granted`: the browser came back with a code. The window trades the three values for a
 *   session, on its own origin, so that Chromium keeps the cookie and the shell never holds it.
 *   They cross the bridge once, to the document that started the attempt, and are not kept here.
 * - `Failed`: the browser came back without a code. Google or the server did not sign the Person
 *   in (they closed Google's page, for one).
 * - `Expired`: nothing came back in the five minutes a sign-in at Google may take.
 * - `Cancelled`: the window cancelled it, or started another, or nothing was in progress.
 *
 * The values are plain text here because the sandboxed preload cannot load the contracts
 * package; the window decodes them with `SignInTrade` (`@vivid/contracts/signin`) before use.
 */
export const SignInEnding = Schema.TaggedUnion({
  Granted: { code: NonEmptyString, state: NonEmptyString, verifier: NonEmptyString },
  Failed: {},
  Expired: {},
  Cancelled: {},
})
export type SignInEnding = typeof SignInEnding.Type

/**
 * Where a pressed notification opens, as the page's `NotificationOpens` (`@vivid/contracts`)
 * encodes it. The Thread is plain text for the same reason as `SignInEnding`'s values; the page
 * decodes it when the notice is pressed.
 */
export const DesktopNotificationOpens = Schema.TaggedUnion({
  Thread: { threadId: NonEmptyString },
  Feed: {},
  Notifications: {},
})
export type DesktopNotificationOpens = typeof DesktopNotificationOpens.Type

/**
 * A notification the page heard on its live list, for the shell to show as the system's own while
 * its window is not in front, with where it opens when pressed.
 */
export const DesktopNotification = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  opens: DesktopNotificationOpens,
  /** Shown without a sound: a Feed post Vivid made on its own (`PushSound` in the contracts). */
  silent: Schema.Boolean,
})
export interface DesktopNotification extends Schema.Schema.Type<typeof DesktopNotification> {}

/** Every renderer-to-main capability and argument is schema-decoded in main. */
export const BridgeRequest = Schema.TaggedUnion({
  GetAppVersion: {},
  GetServer: {},
  ChooseServer: { origin: ServerAddress },
  ForgetServer: {},
  OpenExternal: { url: ExternalUrl },
  /**
   * Start signing in with Google: the shell listens on a loopback address and opens the selected
   * server's sign-in in the system browser (`main/signin.ts`). It takes no argument. The address
   * is built by the shell from the server it saved, so a document cannot send the browser
   * anywhere. Starting again replaces an attempt in progress.
   */
  BeginGoogleSignIn: {},
  /** Open the system browser again for the attempt in progress, on the same address. */
  ReopenGoogleSignIn: {},
  /** Wait for the attempt in progress to end. It answers once, when it has. */
  AwaitGoogleSignIn: {},
  /** Stop the attempt in progress and stop listening. */
  CancelGoogleSignIn: {},
  Pages: { request: PagesRequest },
  /** What this computer is to Vivid, as the app last heard it. */
  GetDeviceLink: {},
  /** The Person changed this computer's access: ask the server again now. */
  RefreshDeviceLink: {},
  /**
   * The look the Person chose in Vivid: light, dark, or the system's. The shell makes it the
   * window's own scheme, so what the operating system draws for the window (its buttons, its
   * menus, the colour behind a page that has not loaded) matches the page inside it.
   */
  ShowColorScheme: { preference: ColorSchemePreference },
  /**
   * Show a notification as the system's own. The shell shows it only while its window is not in
   * front: in front, the page says it itself. Electron has no Web Push, so this is how the
   * desktop app tells the Person anything, and only while it runs.
   */
  ShowNotification: { notification: DesktopNotification },
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
  GoogleSignInBegun: { browser: SignInBrowser },
  GoogleSignInEnded: { value: SignInEnding },
  GoogleSignInCancelled: {},
  ColorSchemeShown: {},
  NotificationShown: {},
})
export type BridgeResponse = typeof BridgeResponse.Type

/** Push messages use a separate closed union because they have no pending request. */
export const BridgeEvent = Schema.TaggedUnion({
  ColorSchemeChanged: { value: ColorSchemeState },
  PagesChanged: { value: BrowserState },
  PageDownloadRefused: { value: PageDownloadRefused },
  /** A notification the shell showed was pressed; the window is in front again. */
  NotificationOpened: { opens: DesktopNotificationOpens },
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
const encodeEvent = Schema.encodeOption(BridgeEvent)

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

/**
 * Encode a trusted event before sending it to the isolated renderer. There is nothing to send for
 * an event that will not encode, and the sender then sends nothing.
 */
export const encodeBridgeEvent = (event: BridgeEvent) => encodeEvent(event)

/**
 * Signing in with Google from an app document. The window cannot show Google's sign-in (Google
 * refuses an embedded window), so the shell hands the Person to their system browser and brings
 * the result back. One attempt runs at a time.
 */
export interface VividSignInBridge {
  /**
   * Starts an attempt and opens the system browser on Google's account chooser. It answers as
   * soon as the browser has been asked to open, with whether it did.
   */
  readonly begin: () => Promise<SignInBrowser>
  /** Opens the browser again for the attempt in progress, for a Person who closed it. */
  readonly reopen: () => Promise<SignInBrowser>
  /** Resolves when the attempt in progress ends, with how. */
  readonly ended: () => Promise<SignInEnding>
  /** Stops the attempt in progress. A pending `ended` resolves `Cancelled`. */
  readonly cancel: () => Promise<void>
}

/** The local chooser and web shell import this type without Electron or filesystem authority. */
export interface VividDesktopBridge {
  /**
   * Whether this shell's main process is sending error reports (`main/telemetry.ts`). The page
   * reads it before it starts its own half of the reporting, which only hands reports to main: in
   * a shell that is not reporting (one run from source) there is nobody to hand them to. It is a
   * plain value, not a call, because the page decides before it draws anything.
   */
  readonly reporting: boolean
  readonly pages: VividPagesBridge
  readonly device: VividDeviceBridge
  readonly server: {
    readonly get: () => Promise<ServerSettings>
    readonly choose: (origin: string) => Promise<ServerChoice>
    readonly forget: () => Promise<void>
  }
  readonly getAppVersion: () => Promise<string>
  readonly openExternal: (url: string) => Promise<void>
  readonly signIn: VividSignInBridge
  /** Tells the shell the look the Person chose, so the window's own chrome is drawn to match. */
  readonly colorScheme: { readonly show: (preference: ColorSchemePreference) => Promise<void> }
  /** The system's notifications, while the app runs (`ShowNotification`). */
  readonly notifications: {
    readonly show: (notification: DesktopNotification) => Promise<void>
    /** Hears each notification pressed; answers the way to stop listening. */
    readonly onOpened: (
      listener: (opened: { readonly opens: DesktopNotificationOpens }) => void,
    ) => () => void
  }
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
export type VividAppBridge = Pick<
  VividDesktopBridge,
  'getAppVersion' | 'pages' | 'device' | 'signIn' | 'reporting' | 'colorScheme' | 'notifications'
>
