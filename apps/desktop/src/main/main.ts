import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeProcess from 'node:process'
import * as NodeOS from 'node:os'
import { DeviceName, DeviceWork } from '@vivid/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { app, net, protocol, screen, session, type BrowserWindow, type Session } from 'electron'
import { registerBridge, sendBridgeEvent } from './bridge.ts'
import { Browser } from './browser.ts'
import { executor } from './control.ts'
import { connectDevice, deviceLink, sessionChanges } from './device.ts'
import { controlledBrowser } from './driver.ts'
import { locateComputer } from './computer.ts'
import { createNotice } from './notice.ts'
import { turns } from './turn.ts'
import { installationIdentity } from './installation.ts'
import { resolveHost, vividMayOpen } from './reach.ts'
import { dialTarget, egressAddress, exitLink, isSessionCookie, type ExitSocket } from './egress.ts'
import {
  parseVividUrl,
  VIVID_PROTOCOL,
  vividUrlsFromArguments,
  type VividDeepLink,
} from './links.ts'
import { focusMainWindow, installApplicationMenu, raiseMainWindow } from './menu.ts'
import {
  DisplayWorkArea,
  clampWindowPlacement,
  defaultWindowPlacement,
  readWindowPlacement,
  writeWindowPlacement,
  type WindowPlacement,
} from './placement.ts'
import { ColorSchemeController } from './theme.ts'
import { loadThemeSurfaces, type ThemeSurfaces } from './tokens.ts'
import { RendererSource, createMainWindow, loadRenderer, openExternalUrl } from './window.ts'
import { AppInfo, BridgeEvent, type DesktopPlatform } from '../shared/bridge.ts'
import { PageUnavailable, type Tab } from '../shared/pages.ts'
import { DesktopSettings, settingsLayer } from './settings.ts'
import { clearingLeft, storageLeftBehind } from './leaving.ts'
import { registerAppProxy } from './proxy.ts'
import { APP_PARTITION, secureSession } from './session.ts'
import { isAllowedBridgeRequest } from './security.ts'
import { googleSignIn } from './signin.ts'
import { ServerAddress, ServerSettings } from '../shared/settings.ts'
import { startTelemetry } from './telemetry.ts'

// The app's name, before anything asks where its data is. Electron makes the data folder from the
// name the first time the folder is asked for and keeps that answer, and the workspace package is
// named `@vivid/desktop`. Error reporting asks for the folder as it starts, so while this line
// came after it the app of 12 October 2026 kept its data in `@vivid/desktop`, not `Vivid`: a
// Person who installed it over the one before opened it signed out, with a new identity and none
// of their settings, though nothing of theirs had been deleted. `productName` in `package.json`
// gives Electron the same name before any of this file runs; this line is the same statement
// where it can be read beside what depends on it.
app.setName('Vivid')

// Next, before anything that can fail and before any scheme is registered (`telemetry.ts`).
startTelemetry()

const PLACEMENT_FILE = 'window-placement.json'
const INSTALLATION_FILE = 'installation.json'
/** The host name as the Person's list of computers shows it, cut to what the contract allows. */
const deviceName = Schema.decodeUnknownOption(DeviceName)
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
    // The window is asked first: once it is closed, reading `webContents` itself throws
    // "Object has been destroyed", and closing the app publishes one last change (the browser
    // resets on `closed`), which showed a JavaScript error dialog on every quit.
    publish: (value) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        sendBridgeEvent(window.webContents, BridgeEvent.cases.PagesChanged.make({ value }))
    },
    downloadRefused: (value) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        sendBridgeEvent(window.webContents, BridgeEvent.cases.PageDownloadRefused.make({ value }))
    },
  })
}

/**
 * Vivid using this computer. The executor acts in whichever Browser the open window has; the
 * turn keeper works in the Person's apps through Vivid's Computer and owns the notice; the link
 * enrols this installation, listens while the Person allows it, and hands each piece of work to
 * the one it is for. The installation identity is read here and goes nowhere else in the app. A
 * computer whose identity cannot be kept, or that has no host name, is not linked at all.
 */
const linkThisComputer = Effect.fn('DesktopMain.linkThisComputer')(function* (input: {
  readonly session: Session
  readonly server: () => ServerSettings
  readonly browser: () => Option.Option<Browser>
}) {
  // Everything Vivid holds on this computer outside the app's own window lives in this scope:
  // the Computer process and the fibers around it. Quitting closes it, which kills the Computer;
  // the Computer also ends by itself when this process does (`--parent-pid`).
  const context = Context.empty()
  const held = yield* Scope.make()
  app.on('before-quit', () => {
    Effect.runForkWith(context)(Scope.close(held, Exit.void))
  })
  // The notice calls `stop` only while a turn is up, which is after `windows` exists.
  let stopTurn = (): void => undefined
  const notice = createNotice({
    session: input.session,
    origin: () =>
      ServerSettings.match(input.server(), {
        NoServer: () => Option.none(),
        Server: ({ origin }) => Option.some(origin),
      }),
    stop: () => stopTurn(),
  })
  const windows = yield* turns({
    computer: locateComputer({
      platform: NodeProcess.platform,
      packaged: app.isPackaged,
      resources: NodeProcess.resourcesPath,
      bundle: __dirname,
      parent: NodeProcess.pid,
    }),
    notice: notice.show,
  }).pipe(Scope.provide(held))
  stopTurn = windows.stop
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
      onNone: () => Effect.succeedNone,
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
    ability: () => ({ pages: true, apps: windows.apps, egress: true }),
    execute: (request) =>
      DeviceWork.match(request.work, {
        Page: ({ action }) => control.execute({ action, expiresAt: request.expiresAt }),
        Window: ({ action }) =>
          windows.execute({ runId: request.runId, action, expiresAt: request.expiresAt }),
      }),
    ended: windows.ended,
    // The notice window belongs to one server's origin and one session; it goes with the link.
    unlinked: windows.unlinked.pipe(Effect.andThen(Effect.sync(notice.close))),
    stops: windows.stops,
  })
  // Signing in or out changes the app session's cookies. A different session ends a link opened
  // as the old one at once, action in progress included; anything else is a cue to look again.
  const changed = sessionChanges(new Map())
  // The way out for the Computer's browser (`egress.ts`). It dials the same server as the same
  // session, on a socket of its own, and only while a session cookie is in the app's jar: an
  // app nobody is signed in to would otherwise ask a server that can only refuse it, for ever.
  // The jar is read once here, and the changes below keep `sessions` current after that.
  const sessions = new Set(
    (yield* Effect.promise(() => input.session.cookies.get({})))
      .map((cookie) => cookie.name)
      .filter(isSessionCookie),
  )
  const exit = yield* exitLink({
    socket: (): Option.Option<ExitSocket> => {
      const server = input.server()
      if (ServerSettings.guards.NoServer(server) || sessions.size === 0) return Option.none()
      return Option.some(
        new net.WebSocket(egressAddress(server.origin), {
          session: input.session,
          useSessionCookies: true,
          origin: server.origin,
        }),
      )
    },
    resolve: resolveHost,
    dial: dialTarget,
    // Never from the app: a page on the Computer must not reach into this computer's network.
    allowPrivateTargets: false,
    onStatus: () => undefined,
  })
  input.session.cookies.on('changed', (_event, cookie, cause, removed) => {
    const change = changed({
      name: cookie.name,
      value: cookie.value,
      removed,
      overwritten: cause === 'overwrite',
    })
    if (isSessionCookie(cookie.name)) {
      if (removed && cause !== 'overwrite') sessions.delete(cookie.name)
      else sessions.add(cookie.name)
    }
    if (change === 'Restart') {
      computer.restart()
      // A socket opened as the old session must not go on carrying for the new one.
      exit.restart()
    } else computer.wake()
  })
  yield* Effect.forkDetach(exit.run.pipe(Effect.setContext(context)), { startImmediately: true })
  // The detached link outlives boot; settings and startup spans must not become its context.
  yield* Effect.forkDetach(computer.run.pipe(Effect.setContext(context)), {
    startImmediately: true,
  })
  return { computer, control, exit }
})

/**
 * Where the window opens: where it was last, when that was saved and still lies on a display
 * that is connected now, and the default otherwise. Placement is a convenience, so a file that
 * cannot be read is the default too, never a startup that fails.
 */
const startingPlacement = Effect.fn('DesktopMain.startingPlacement')(function* (path: string) {
  const stored = Option.getOrElse(
    yield* readWindowPlacement(path).pipe(Effect.option),
    () => defaultWindowPlacement,
  )
  const workAreas = screen.getAllDisplays().map((display) => DisplayWorkArea.make(display.workArea))
  return Option.getOrElse(clampWindowPlacement(stored, workAreas), () => defaultWindowPlacement)
})

/**
 * Google sign-in through the system browser (`signin.ts`). Its listener on the loopback address
 * lives in a scope the app closes as it quits, so no port outlives the app that opened it. The
 * server is the saved one, read when an attempt begins: never an address a document sent.
 *
 * An attempt belongs to the server it began on: its code could only be traded there, and the
 * document waiting for it is replaced when the server changes. So `serverChanged` cancels it.
 */
const signInThroughBrowser = Effect.fn('DesktopMain.signIn')(function* (input: {
  readonly server: () => ServerSettings
  readonly surfaces: ThemeSurfaces
}) {
  const context = yield* Effect.context<never>()
  const untilQuit = yield* Scope.make()
  app.once('will-quit', () => {
    Effect.runForkWith(context)(Scope.close(untilQuit, Exit.void))
  })
  return yield* googleSignIn({
    server: input.server,
    open: openExternalUrl,
    random: (size) => NodeCrypto.randomBytes(size),
    focus: () => raiseMainWindow(platform, mainWindow),
    surfaces: input.surfaces,
  }).pipe(Scope.provide(untilQuit))
})

const ShippedManifest = Schema.fromJsonString(
  Schema.Struct({ vividHome: Schema.OptionFromOptionalKey(ServerAddress) }),
)
const decodeShippedManifest = Schema.decodeUnknownOption(ShippedManifest)

/** The packaged manifest could not be read; the build then has no home of its own. */
class ManifestUnreadable extends Schema.TaggedError<ManifestUnreadable>()(
  'ManifestUnreadable',
  {},
  { title: 'Desktop manifest could not be read' },
) {}

/**
 * The Vivid address this build ships with, when it ships with one. Packaging writes it into the
 * app's own `package.json` as `vividHome` (`electron-builder.yml`, `extraMetadata`), which keeps
 * the address out of the source and out of the web bundle. Development has no packaged manifest
 * and starts at the chooser. A manifest that cannot be read (absent, not a file, no permission),
 * or an address that is not a valid server origin, is no home: the chooser is the honest start
 * then, not a guessed address, and never a startup that dies before its first window.
 */
const shippedHome = Effect.fn('DesktopMain.shippedHome')(function* () {
  if (!app.isPackaged) return Option.none<ServerAddress>()
  const manifest = NodePath.join(app.getAppPath(), 'package.json')
  const text = yield* Effect.try({
    try: () => NodeFS.readFileSync(manifest, 'utf8'),
    catch: () => new ManifestUnreadable({}),
  }).pipe(Effect.option)
  return Option.flatMap(Option.flatMap(text, decodeShippedManifest), (decoded) => decoded.vividHome)
})

/**
 * Finish startup after Electron is ready: decode configuration and disk state, construct one window,
 * and install bridge handlers. Placement failure is deliberately recoverable because geometry is a
 * convenience cache; renderer, token, and runtime metadata failures stop startup instead.
 */
const boot = Effect.fn('DesktopMain.boot')(function* () {
  // Callbacks retain only their HTTP transport, without startup settings or the boot span.
  const context = Context.make(HttpClient.HttpClient, yield* HttpClient.HttpClient)
  registerProtocolClient()

  const surfaces = yield* loadThemeSurfaces(themeTokensPath())
  const settings = yield* DesktopSettings
  let serverSettings = yield* settings.get
  const root = app.isPackaged
    ? NodePath.join(NodeProcess.resourcesPath, 'web', 'dist')
    : NodePath.resolve(__dirname, '../renderer')
  const chooserPath = NodePath.join(root, 'chooser.html')
  const chooserUrl = NodeURL.pathToFileURL(chooserPath).href
  const desktopSession = session.fromPartition(APP_PARTITION)
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
    run: (program) => Effect.runPromiseWith(context)(program),
  })
  const information = yield* appInfo()
  const placementPath = NodePath.join(app.getPath('userData'), PLACEMENT_FILE)
  let placement = yield* startingPlacement(placementPath)
  const colorScheme = new ColorSchemeController(surfaces)
  let browser = Option.none<Browser>()
  const pagesSession = session.fromPartition('persist:vivid-pages')

  const { computer, control, exit } = yield* linkThisComputer({
    session: desktopSession,
    server: () => serverSettings,
    browser: () => browser,
  })

  const signIn = yield* signInThroughBrowser({ server: () => serverSettings, surfaces })
  /** A different server, or none: every page closes and the window loads what that means. */
  const serverChanged = (value: ServerSettings): void => {
    Option.map(browser, (available) => available.reset())
    Effect.runForkWith(context)(signIn.cancel) // a sign-in belongs to the server it began on
    // The left server's storage is cleared (`leaving.ts`) only after the window has loaded what
    // replaces its document: that document writes as it unloads, which would follow the clear.
    const clearLeft = clearingLeft(storageLeftBehind(serverSettings, value), desktopSession)
    serverSettings = value
    // A link belongs to one server: drop it and start over on the new one, or on none.
    computer.restart()
    exit.restart()
    // Complete invoke before replacing the document that owns its pending Promise.
    setImmediate(() =>
      runNonFatal(
        Option.match(mainWindow, {
          onNone: () => clearLeft,
          onSome: (window) => Effect.ensuring(loadRenderer(window, renderer()), clearLeft),
        }),
        'desktop: renderer failed to load',
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
      showColorScheme: (preference) => colorScheme.show(preference),
      settings,
      openExternal: openExternalUrl,
      signIn,
      onServerChanged: serverChanged,
    },
    runtime: { run: (program) => Effect.runPromiseWith(context)(program) },
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
        Effect.runSyncWith(context)(
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
    Effect.flatMap(shippedHome),
    Effect.flatMap((home) =>
      boot().pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- Electron main startup owns the application settings and HTTP client Layer.
        Effect.provide(
          Layer.mergeAll(
            settingsLayer(NodePath.join(app.getPath('userData'), 'settings.json'), home),
            FetchHttpClient.layer,
          ),
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
