import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import type { DesktopPlatform } from '../shared/bridge.ts'
import { sendColorSchemeChanged } from './bridge.ts'
import { WindowPlacement, type WindowPlacement as WindowPlacementValue } from './placement.ts'
import type { ColorSchemeController } from './theme.ts'

const SIDEBAR_WIDTH = 268

/** The renderer is either one validated development origin or one packaged file. */
export const RendererSource = Schema.TaggedUnion({
  Development: { url: Schema.URL },
  Packaged: { file: Schema.String },
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

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

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
        color: colorScheme.background(),
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

/** Decide whether a navigation remains inside the exact renderer document or development origin. */
function isRendererDocument(url: string, source: RendererSource): boolean {
  return Option.match(decodeUrl(url), {
    onNone: () => false,
    onSome: (parsed) =>
      RendererSource.match(source, {
        Development: ({ url: developmentUrl }) => parsed.origin === developmentUrl.origin,
        Packaged: ({ file }) => parsed.href === NodeURL.pathToFileURL(file).href,
      }),
  })
}

/** Only explicit browser, mail, and telephone schemes may leave the desktop shell. */
export function openExternalUrl(url: string) {
  return Option.match(decodeUrl(url), {
    onNone: () => Effect.void,
    onSome: (parsed) => {
      const allowed = ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)
      if (!allowed) return Effect.void
      return Effect.tryPromise({
        try: () => shell.openExternal(parsed.href),
        catch: () => new ExternalUrlOpenFailed({ url: parsed.href }),
      })
    },
  })
}

/** Block popups and off-origin navigation while handing allowed destinations to the OS. */
function guardNavigation(
  window: BrowserWindow,
  source: RendererSource,
  onExternalUrl: (url: string) => void,
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    onExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isRendererDocument(url, source)) return
    event.preventDefault()
    onExternalUrl(url)
  })
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
  readonly renderer: RendererSource
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
    },
  })

  window.once('ready-to-show', () => window.show())
  const unsubscribeColorScheme = dependencies.colorScheme.onChange((state) => {
    if (window.isDestroyed()) return
    window.setBackgroundColor(dependencies.colorScheme.background())
    if (dependencies.platform === 'win32') {
      window.setTitleBarOverlay({
        color: dependencies.colorScheme.background(),
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
    Development: ({ url }) => url.href,
    Packaged: ({ file }) => file,
  })
  yield* Effect.tryPromise({
    try: () =>
      RendererSource.match(source, {
        Development: ({ url }) => window.loadURL(url.href),
        Packaged: ({ file }) => window.loadFile(file),
      }),
    catch: () => new RendererLoadFailed({ source: label }),
  })
})
