import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { BrowserWindow, shell, type BrowserWindowConstructorOptions, type Session } from 'electron'
import { ExternalUrl, REPORTING_ARGUMENT, type DesktopPlatform } from '../shared/bridge.ts'
import { isAppRequest, isTrustedDocument } from './security.ts'
import { ServerAddress, ServerSettings } from '../shared/settings.ts'
import { sendColorSchemeChanged } from './bridge.ts'
import { reporting } from './telemetry.ts'
import { WindowPlacement, type WindowPlacement as WindowPlacementValue } from './placement.ts'
import type { ColorSchemeController } from './theme.ts'

const SIDEBAR_WIDTH = 268

/** An unconfigured shell loads only its local chooser; a chosen server supplies one origin. */
export const RendererSource = Schema.TaggedUnion({
  Chooser: { path: Schema.String },
  Server: { origin: ServerAddress },
})
export type RendererSource = typeof RendererSource.Type

/** Electron could not load the selected renderer resource. */
export class RendererLoadFailed extends Schema.TaggedError<RendererLoadFailed>()(
  'RendererLoadFailed',
  { source: Schema.String },
  { title: 'Desktop renderer failed to load' },
) {}

/** Electron could not hand an allowed external URL to the operating system. */
export class ExternalUrlOpenFailed extends Schema.TaggedError<ExternalUrlOpenFailed>()(
  'ExternalUrlOpenFailed',
  { url: Schema.String },
  { title: 'External URL could not be opened' },
) {}

const decodeExternal = Schema.decodeUnknownOption(ExternalUrl)

/**
 * What Windows paints behind the window's own buttons: nothing, so the page shows through and the
 * strip can never be a block of another colour than the page under it. T3 Code's value
 * (`TITLEBAR_COLOR` in `apps/desktop/src/window/DesktopWindow.ts`): one step off fully clear,
 * because fully clear is not drawn correctly everywhere.
 */
const OVERLAY_CLEAR = '#01000000'

/** Platform chrome is selected from an injected host value so cross-platform branches stay pure. */
function chromeOptions(
  platform: DesktopPlatform,
  colorScheme: ColorSchemeController,
): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      // Traffic lights stay in the content gutter, outside the 268px product sidebar.
      trafficLightPosition: { x: SIDEBAR_WIDTH + 16, y: 14 },
    }
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: OVERLAY_CLEAR,
        symbolColor: colorScheme.overlaySymbolColor(),
        height: 36,
      },
    }
  }
  return {}
}

/** Convert the honest placement variant into Electron's optional constructor fields. */
const placementOptions = (
  placement: WindowPlacementValue,
): Pick<BrowserWindowConstructorOptions, 'width' | 'height' | 'x' | 'y'> =>
  WindowPlacement.match(placement, {
    Centered: ({ width, height }) => ({ width, height }),
    Positioned: ({ width, height, x, y }) => ({ width, height, x, y }),
  })

/** Compare chooser documents exactly and selected server navigation by its single origin. */
function isRendererDocument(url: string, source: RendererSource): boolean {
  return RendererSource.match(source, {
    Chooser: ({ path }) =>
      isTrustedDocument(
        url,
        ServerSettings.cases.NoServer.make({}),
        NodeURL.pathToFileURL(path).href,
      ),
    Server: ({ origin }) =>
      /^https?:/.test(url) && isAppRequest(url, ServerSettings.cases.Server.make({ origin })),
  })
}

/** Only explicit HTTP(S) browser destinations may leave the desktop shell. */
export function openExternalUrl(url: string) {
  return Option.match(decodeExternal(url), {
    onNone: () => Effect.void,
    onSome: (destination) =>
      Effect.tryPromise({
        try: () => shell.openExternal(destination),
        catch: () => new ExternalUrlOpenFailed({ url: destination }),
      }),
  })
}

/**
 * Adapt the reference desktop's main-window navigation guard (window/DesktopWindow.ts): new
 * windows never gain preload authority, foreign browser links leave the shell, and redirects
 * cannot change the trusted application origin.
 */
function guardNavigation(
  window: BrowserWindow,
  source: () => RendererSource,
  onExternalUrl: (url: string) => void,
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isRendererDocument(url, source())) onExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isRendererDocument(url, source())) return
    event.preventDefault()
    onExternalUrl(url)
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isRendererDocument(url, source())) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

/** Coalesce resize and move bursts while always persisting the final close geometry. */
function persistGeometry(
  window: BrowserWindow,
  onPlacementChanged: (placement: WindowPlacementValue) => void,
): void {
  const persist = (): void => {
    if (window.isDestroyed() || window.isMinimized()) return
    const bounds = window.getNormalBounds()
    onPlacementChanged(
      WindowPlacement.cases.Positioned.make({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: window.isMaximized(),
      }),
    )
  }
  let writeScheduled = false
  const schedule = (): void => {
    if (writeScheduled) return
    writeScheduled = true
    setImmediate(() => {
      writeScheduled = false
      persist()
    })
  }
  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('close', persist)
}

export interface MainWindowDependencies {
  readonly platform: DesktopPlatform
  readonly colorScheme: ColorSchemeController
  readonly renderer: () => RendererSource
  readonly session: Session
  readonly placement: WindowPlacementValue
  readonly onExternalUrl: (url: string) => void
  readonly onPlacementChanged: (placement: WindowPlacementValue) => void
}

/**
 * Construct one secure native window. Electron remains outside the domain model: dependencies are
 * validated values and callbacks, context isolation is mandatory, and no Node authority reaches
 * renderer JavaScript.
 */
export function createMainWindow(dependencies: MainWindowDependencies): BrowserWindow {
  const window = new BrowserWindow({
    title: 'Vivid',
    ...placementOptions(dependencies.placement),
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: dependencies.colorScheme.background(),
    ...chromeOptions(dependencies.platform, dependencies.colorScheme),
    webPreferences: {
      preload: NodePath.join(__dirname, '../preload/main.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      session: dependencies.session,
      // The page reports its errors through this process or not at all, so it is told which.
      additionalArguments: reporting() ? [REPORTING_ARGUMENT] : [],
    },
  })

  window.once('ready-to-show', () => window.show())
  const unsubscribeColorScheme = dependencies.colorScheme.onChange((state) => {
    if (window.isDestroyed()) return
    window.setBackgroundColor(dependencies.colorScheme.background())
    if (dependencies.platform === 'win32') {
      window.setTitleBarOverlay({
        color: OVERLAY_CLEAR,
        symbolColor: dependencies.colorScheme.overlaySymbolColor(),
      })
    }
    sendColorSchemeChanged(window.webContents, state)
  })
  window.on('closed', unsubscribeColorScheme)

  guardNavigation(window, dependencies.renderer, dependencies.onExternalUrl)
  persistGeometry(window, dependencies.onPlacementChanged)
  if (dependencies.placement.maximized) window.maximize()
  return window
}

/** Load the selected renderer through one typed Promise adapter after the window exists. */
export const loadRenderer = Effect.fn('DesktopWindow.loadRenderer')(function* (
  window: BrowserWindow,
  source: RendererSource,
) {
  const label = RendererSource.match(source, {
    Chooser: ({ path }) => path,
    Server: ({ origin }) => origin,
  })
  yield* Effect.tryPromise({
    try: () =>
      RendererSource.match(source, {
        Chooser: ({ path }) => window.loadFile(path),
        Server: ({ origin }) => window.loadURL(origin),
      }),
    catch: () => new RendererLoadFailed({ source: label }),
  })
})
