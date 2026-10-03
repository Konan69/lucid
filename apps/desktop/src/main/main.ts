import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeProcess from 'node:process'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { app, protocol, screen, session, type BrowserWindow, type Session } from 'electron'
import { registerBridge } from './bridge.ts'
import { Browser } from './browser.ts'
import {
  parseVividUrl,
  VIVID_PROTOCOL,
  vividUrlsFromArguments,
  type VividDeepLink,
} from './links.ts'
import { focusMainWindow, installApplicationMenu } from './menu.ts'
import {
  DisplayWorkArea,
  clampWindowPlacement,
  defaultWindowPlacement,
  readWindowPlacement,
  writeWindowPlacement,
  type WindowPlacement,
} from './placement.ts'
import { ColorSchemeController } from './theme.ts'
import { loadThemeSurfaces } from './tokens.ts'
import { RendererSource, createMainWindow, loadRenderer, openExternalUrl } from './window.ts'
import {
  AppInfo,
  BRIDGE_EVENT_CHANNEL,
  BridgeEvent,
  encodeBridgeEvent,
  type DesktopPlatform,
} from '../shared/bridge.ts'
import { PageUnavailable } from '../shared/pages.ts'
import { DesktopSettings, settingsLayer } from './settings.ts'
import { registerAppProxy } from './proxy.ts'
import { secureSession } from './session.ts'
import { isAllowedBridgeRequest } from './security.ts'
import { ServerSettings } from '../shared/settings.ts'

const PLACEMENT_FILE = 'window-placement.json'
// The workspace package name is scoped; native application identity and userData must use Vivid.
app.setName('Vivid')
const knownPlatform = Schema.decodeUnknownOption(
  Schema.Literals(['darwin', 'win32', 'linux'] as const),
)
const decodeNonEmptyString = Schema.decodeUnknownEffect(AppInfo.fields.appVersion)

/** Electron runtime metadata was absent, so truthful renderer metadata cannot be constructed. */
class DesktopRuntimeInvalid extends Schema.TaggedError<DesktopRuntimeInvalid>()(
  'DesktopRuntimeInvalid',
  { field: Schema.String },
  { title: 'Desktop runtime metadata is invalid' },
) {}

/** Map Node's broader platform vocabulary into the bridge's deliberate public vocabulary. */
const desktopPlatform = (platform: NodeJS.Platform): DesktopPlatform =>
  Option.getOrElse(knownPlatform(platform), () => 'other')

const platform = desktopPlatform(NodeProcess.platform)
let mainWindow = Option.none<BrowserWindow>()
let createWindowAction = Option.none<() => void>()
const pendingDeepLinks: VividDeepLink[] = []

/** Focus an existing window or retain the already-validated activation until startup completes. */
function activateDeepLink(link: VividDeepLink): void {
  Option.match(mainWindow, {
    onNone: () => {
      pendingDeepLinks.push(link)
    },
    onSome: () => {
      console.info(`desktop: vivid deep link ${link.host}${link.path}`)
      focusMainWindow(mainWindow)
    },
  })
}

/** Decode one OS callback payload synchronously at Electron's framework boundary. */
function acceptDeepLink(url: string): void {
  Option.match(Effect.runSync(parseVividUrl(url).pipe(Effect.option)), {
    onNone: () => undefined,
    onSome: activateDeepLink,
  })
}

/** Decode process arguments once, retaining only valid Vivid activations. */
function acceptArgumentDeepLinks(arguments_: ReadonlyArray<string>): void {
  const links = Effect.runSync(vividUrlsFromArguments(arguments_))
  for (const link of links) activateDeepLink(link)
}

/** Register the custom protocol with the executable shape Electron requires in development. */
function registerProtocolClient(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(VIVID_PROTOCOL)
    return
  }
  const entry = Option.fromNullishOr(NodeProcess.argv[1])
  if (!NodeProcess.defaultApp || Option.isNone(entry)) return
  app.setAsDefaultProtocolClient(VIVID_PROTOCOL, NodeProcess.execPath, [
    NodePath.resolve(entry.value),
  ])
}

/** Resolve the shared token file from its one development or packaged location. */
function themeTokensPath(): string {
  return app.isPackaged
    ? NodePath.join(NodeProcess.resourcesPath, 'design-tokens', 'tokens.css')
    : NodePath.resolve(__dirname, '../../../../packages/design/tokens/src/tokens.css')
}

/** Validate runtime-owned strings before publishing them through the bridge. */
const appInfo = Effect.fn('DesktopMain.appInfo')(function* () {
  const appVersion = yield* decodeNonEmptyString(app.getVersion()).pipe(
    Effect.mapError(() => new DesktopRuntimeInvalid({ field: 'appVersion' })),
  )
  const electronVersion = yield* decodeNonEmptyString(NodeProcess.versions.electron).pipe(
    Effect.mapError(() => new DesktopRuntimeInvalid({ field: 'electronVersion' })),
  )
  return AppInfo.make({ appVersion, electronVersion, platform })
})

/** Run a non-fatal asynchronous Electron adapter and keep its typed failure inside main. */
function runNonFatal(program: Effect.Effect<void, object>, message: string): void {
  void Effect.runPromise(
    program.pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sync(() => console.error(message)),
        onSuccess: () => Effect.void,
      }),
    ),
  )
}

/** Page events target only their owning app window; guests never receive a bridge event channel. */
function createBrowser(window: BrowserWindow, pagesSession: Session): Browser {
  return new Browser({
    window,
    session: pagesSession,
    run: (program) => {
      void Effect.runPromise(program)
    },
    publish: (value) => {
      if (!window.webContents.isDestroyed())
        window.webContents.send(
          BRIDGE_EVENT_CHANNEL,
          encodeBridgeEvent(BridgeEvent.cases.PagesChanged.make({ value })),
        )
    },
    downloadRefused: (value) => {
      if (!window.webContents.isDestroyed())
        window.webContents.send(
          BRIDGE_EVENT_CHANNEL,
          encodeBridgeEvent(BridgeEvent.cases.PageDownloadRefused.make({ value })),
        )
    },
  })
}

/**
 * Finish startup after Electron is ready: decode configuration and disk state, construct one window,
 * and install bridge handlers. Placement failure is deliberately recoverable because geometry is a
 * convenience cache; renderer, token, and runtime metadata failures stop startup instead.
 */
const boot = Effect.fn('DesktopMain.boot')(function* () {
  registerProtocolClient()

  const surfaces = yield* loadThemeSurfaces(themeTokensPath())
  const settings = yield* DesktopSettings
  let serverSettings = yield* settings.get
  const root = app.isPackaged
    ? NodePath.join(NodeProcess.resourcesPath, 'web', 'dist')
    : NodePath.resolve(__dirname, '../renderer')
  const chooserPath = NodePath.join(root, 'chooser.html')
  const chooserUrl = NodeURL.pathToFileURL(chooserPath).href
  const desktopSession = session.fromPartition('persist:vivid')
  /** Protocol, navigation, permissions, and IPC follow the same durable selection. */
  const renderer = (): RendererSource =>
    ServerSettings.match<RendererSource>(serverSettings, {
      NoServer: () => RendererSource.cases.Chooser.make({ path: chooserPath }),
      Server: ({ origin }) => RendererSource.cases.Server.make({ origin }),
    })
  secureSession(desktopSession, () => serverSettings)
  registerAppProxy({
    root,
    session: desktopSession,
    server: () => serverSettings,
    run: (program) => Effect.runPromise(program),
  })
  const information = yield* appInfo()
  const placementPath = NodePath.join(app.getPath('userData'), PLACEMENT_FILE)
  const storedPlacement = Option.getOrElse(
    yield* readWindowPlacement(placementPath).pipe(Effect.option),
    () => defaultWindowPlacement,
  )
  const workAreas = screen.getAllDisplays().map((display) => DisplayWorkArea.make(display.workArea))
  let placement = Option.getOrElse(
    clampWindowPlacement(storedPlacement, workAreas),
    () => defaultWindowPlacement,
  )
  const colorScheme = new ColorSchemeController(surfaces)
  let browser = Option.none<Browser>()
  const pagesSession = session.fromPartition('persist:vivid-pages')

  /** A different server, or none: every page closes and the window loads what that means. */
  const serverChanged = (value: ServerSettings): void => {
    Option.map(browser, (available) => available.reset())
    serverSettings = value
    // Complete invoke before replacing the document that owns its pending Promise.
    setImmediate(() =>
      Option.map(mainWindow, (window) =>
        runNonFatal(loadRenderer(window, renderer()), 'desktop: renderer failed to load'),
      ),
    )
  }

  // The menu is the one place a Person can leave a server: the app's own document is deliberately
  // refused that request over the bridge, so before this the only way was to delete a settings file.
  installApplicationMenu(platform, () =>
    runNonFatal(
      settings.forget.pipe(Effect.map(serverChanged)),
      'desktop: the server could not be forgotten',
    ),
  )

  registerBridge({
    handlers: {
      pages: (request) =>
        Option.match(browser, {
          onNone: () => Effect.fail(new PageUnavailable({})),
          onSome: (available) => available.handle(request),
        }),
      getAppVersion: () => information.appVersion,
      settings,
      openExternal: openExternalUrl,
      onServerChanged: serverChanged,
    },
    runtime: { run: (program) => Effect.runPromise(program) },
    isTrustedSender: (id, url, request) =>
      Option.exists(
        mainWindow,
        (window) =>
          window.webContents.id === id &&
          isAllowedBridgeRequest(url, serverSettings, chooserUrl, request),
      ),
  })

  const createWindow = (): void => {
    const window = createMainWindow({
      platform,
      colorScheme,
      renderer,
      session: desktopSession,
      placement,
      onExternalUrl: (url) =>
        runNonFatal(openExternalUrl(url), 'desktop: failed to open external URL'),
      onPlacementChanged: (next: WindowPlacement) => {
        placement = next
        Effect.runSync(
          writeWindowPlacement(placementPath, next).pipe(
            Effect.matchEffect({
              onFailure: () =>
                Effect.sync(() => console.error('desktop: failed to save window placement')),
              onSuccess: () => Effect.void,
            }),
          ),
        )
      },
    })
    mainWindow = Option.some(window)
    browser = Option.some(createBrowser(window, pagesSession))
    window.on('closed', () => {
      mainWindow = Option.none()
      browser = Option.none()
    })
    runNonFatal(loadRenderer(window, renderer()), 'desktop: renderer failed to load')
  }

  createWindowAction = Option.some(createWindow)
  createWindow()
  for (const link of pendingDeepLinks.splice(0)) activateDeepLink(link)
  acceptArgumentDeepLinks(NodeProcess.argv)
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  protocol.registerSchemesAsPrivileged([
    { scheme: VIVID_PROTOCOL, privileges: { standard: true, secure: true } },
  ])

  app.on('second-instance', (_event, arguments_) => {
    acceptArgumentDeepLinks(arguments_)
    focusMainWindow(mainWindow)
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    acceptDeepLink(url)
  })
  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (Option.isSome(mainWindow) && !mainWindow.value.isDestroyed()) return
    Option.match(createWindowAction, {
      onNone: () => undefined,
      onSome: (createWindow) => createWindow(),
    })
  })

  const launch = Effect.tryPromise({
    try: () => app.whenReady(),
    catch: () => new DesktopRuntimeInvalid({ field: 'readiness' }),
  }).pipe(
    Effect.flatMap(() =>
      boot().pipe(
        Effect.provide(settingsLayer(NodePath.join(app.getPath('userData'), 'settings.json'))),
      ),
    ),
    Effect.matchEffect({
      onFailure: () =>
        Effect.sync(() => {
          console.error('desktop: failed to start')
          app.quit()
        }),
      onSuccess: () => Effect.void,
    }),
  )
  void Effect.runPromise(launch)
}
