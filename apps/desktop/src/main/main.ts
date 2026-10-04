import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeProcess from 'node:process'
import * as NodeOS from 'node:os'
import { DeviceName } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { app, net, protocol, screen, session, type BrowserWindow, type Session } from 'electron'
import { registerBridge } from './bridge.ts'
import { Browser } from './browser.ts'
import { executor } from './control.ts'
import { connectDevice, deviceLink, sessionChanges } from './device.ts'
import { controlledBrowser } from './driver.ts'
import { installationIdentity } from './installation.ts'
import { vividMayOpen } from './reach.ts'
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
import { PageUnavailable, type Tab } from '../shared/pages.ts'
import { DesktopSettings, settingsLayer } from './settings.ts'
import { registerAppProxy } from './proxy.ts'
import { secureSession } from './session.ts'
import { isAllowedBridgeRequest } from './security.ts'
import { ServerSettings } from '../shared/settings.ts'

const PLACEMENT_FILE = 'window-placement.json'
const INSTALLATION_FILE = 'installation.json'
/** The host name as the Person's list of computers shows it, cut to what the contract allows. */
const deviceName = Schema.decodeUnknownOption(DeviceName)
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
function createBrowser(
  window: BrowserWindow,
  pagesSession: Session,
  stopVivid: (tab: Tab) => void,
): Browser {
  return new Browser({
    window,
    session: pagesSession,
    stopVivid,
    mayOpen: vividMayOpen,
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
 * Vivid using this computer. The executor acts in whichever Browser the open window has; the
 * link enrols this installation, listens while the Person allows it, and hands each action to
 * the executor. The installation identity is read here and goes nowhere else in the app. A
 * computer whose identity cannot be kept, or that has no host name, is not linked at all.
 */
const linkThisComputer = Effect.fn('DesktopMain.linkThisComputer')(function* (input: {
  readonly session: Session
  readonly server: () => ServerSettings
  readonly browser: () => Option.Option<Browser>
}) {
  const control = yield* executor({
    browser: controlledBrowser(input.browser),
    mac: platform === 'darwin',
    mayOpen: vividMayOpen,
    using: (tab) => {
      Option.map(input.browser(), (available) => available.used(tab))
    },
  })
  const identity = Option.all({
    installation: yield* installationIdentity(
      NodePath.join(app.getPath('userData'), INSTALLATION_FILE),
    ).pipe(Effect.option),
    name: deviceName(NodeOS.hostname().slice(0, 100)),
  })
  if (Option.isNone(identity)) console.error('desktop: this computer cannot be linked to Vivid')
  const computer = yield* deviceLink({
    connect: Option.match(identity, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (known) =>
        connectDevice({
          server: input.server,
          // Electron's own WebSocket, in the app's session and with its cookies on the upgrade
          // (electron.d.ts, `WebSocketOptions.session` and `useSessionCookies`). Never the pages
          // partition. The main process does not read the cookie. The class lives on `net` at
          // run time: Electron 44.4.3 does not export `WebSocket` from `electron` itself, though
          // its declarations say so (`scripts/control.ts` proves both).
          socket: (address, origin) =>
            new net.WebSocket(address, {
              session: input.session,
              useSessionCookies: true,
              origin,
            }),
          identity: known,
        }),
    }),
    execute: control.execute,
  })
  // Signing in or out changes the app session's cookies. A different session ends a link opened
  // as the old one at once, action in progress included; anything else is a cue to look again.
  const changed = sessionChanges(new Map())
  input.session.cookies.on('changed', (_event, cookie, cause, removed) => {
    const change = changed({
      name: cookie.name,
      value: cookie.value,
      removed,
      overwritten: cause === 'overwrite',
    })
    if (change === 'Restart') computer.restart()
    else computer.wake()
  })
  Effect.runFork(computer.run)
  return { computer, control }
})

const ShippedManifest = Schema.fromJsonString(
  Schema.Struct({ vividHome: Schema.OptionFromOptionalKey(ServerAddress) }),
)
const decodeShippedManifest = Schema.decodeUnknownOption(ShippedManifest)

/**
 * The Vivid address this build ships with, when it ships with one. Packaging writes it into the
 * app's own `package.json` as `vividHome` (`electron-builder.yml`, `extraMetadata`), which keeps
 * the address out of the source and out of the web bundle. Development has no packaged manifest
 * and starts at the chooser. A manifest that cannot be read, or an address that is not a valid
 * server origin, is no home: the chooser is the honest start then, not a guessed address.
 */
function shippedHome(): Option.Option<ServerAddress> {
  if (!app.isPackaged) return Option.none()
  const manifest = NodePath.join(app.getAppPath(), 'package.json')
  if (!NodeFS.existsSync(manifest)) return Option.none()
  return Option.flatMap(
    decodeShippedManifest(NodeFS.readFileSync(manifest, 'utf8')),
    (decoded) => decoded.vividHome,
  )
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

  const { computer, control } = yield* linkThisComputer({
    session: desktopSession,
    server: () => serverSettings,
    browser: () => browser,
  })

  /** A different server, or none: every page closes and the window loads what that means. */
  const serverChanged = (value: ServerSettings): void => {
    Option.map(browser, (available) => available.reset())
    serverSettings = value
    // A link belongs to one server: drop it and start over on the new one, or on none.
    computer.restart()
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
      device: computer,
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
    browser = Option.some(createBrowser(window, pagesSession, control.stop))
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
        Effect.provide(
          settingsLayer(NodePath.join(app.getPath('userData'), 'settings.json'), shippedHome()),
        ),
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
