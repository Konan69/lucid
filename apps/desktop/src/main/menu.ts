import * as Option from 'effect/Option'
import * as NodeEvents from 'node:events'
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { DesktopPlatform } from '../shared/bridge.ts'

/** App zoom changes also reposition the native page viewport; Electron's zoom event covers wheels only. */
export const pageZoomChanges = new NodeEvents.EventEmitter<{ changed: [BrowserWindow] }>()

/** Follow Electron 44.4.3 role increments, then notify the window that owns native guest bounds.
 * @public Called by scripts/pages.ts, which Knip's desktop project does not scan. */
export function zoomPage(window: BrowserWindow, change: 'reset' | 'in' | 'out'): void {
  const level = window.webContents.getZoomLevel()
  window.webContents.setZoomLevel(change === 'reset' ? 0 : level + (change === 'in' ? 0.5 : -0.5))
  pageZoomChanges.emit('changed', window)
}

/** Menu and accelerator zoom share one public adapter so guest bounds cannot lag behind app zoom. */
function zoomItem(
  label: string,
  accelerator: string,
  change: 'reset' | 'in' | 'out',
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, window) => {
      // Electron 44 supplies BaseWindow here too; only BrowserWindow owns app webContents.
      if (window instanceof BrowserWindow) zoomPage(window, change)
    },
  }
}

/**
 * Build standard menus from the injected host platform, with owned zoom geometry notifications.
 *
 * `changeServer` takes the app back to its first screen to be pointed at another Vivid. It sits
 * in the File menu on every platform because that is the menu all three have.
 */
export function installApplicationMenu(platform: DesktopPlatform, changeServer: () => void): void {
  const mac = platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Use a Different Vivid…', click: changeServer },
        { type: 'separator' },
        ...(mac ? [] : [{ role: 'quit' as const }]),
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        zoomItem('Actual Size', 'CommandOrControl+0', 'reset'),
        zoomItem('Zoom In', 'CommandOrControl+Plus', 'in'),
        zoomItem('Zoom Out', 'CommandOrControl+-', 'out'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Bring an existing window forward; absence is a normal macOS lifecycle state. */
export function focusMainWindow(window: Option.Option<BrowserWindow>): void {
  Option.match(window, {
    onNone: () => undefined,
    onSome: (available) => {
      if (available.isDestroyed()) return
      if (available.isMinimized()) available.restore()
      available.show()
      available.focus()
    },
  })
}

/**
 * Put the window in front of another application's windows and give it the keyboard, for the one
 * moment the Person is somewhere else and Vivid has something for them: their browser has just
 * signed them in.
 *
 * `focusMainWindow` is not enough there. It is right when the operating system has handed this
 * app the front, as it does for a second launch or a menu command. Here the browser holds the
 * front, and Windows refuses it to any process that does not (the rules of
 * `SetForegroundWindow`): `focus()` only makes the taskbar button flash.
 *
 * On Windows the window is minimized and restored. Restoring a minimized window is the one
 * activation Windows grants a process that does not hold the front. Measured on Windows 11 on
 * 13 October 2026 with the packaged app, a real browser in front and this run in the main
 * process: after minimize, restore and focus, Vivid's window was the foreground window within
 * 60 ms, six times of six, maximized or not, and a maximized window came back maximized. Before
 * that this only made the window topmost for an instant: it came above the browser, but the
 * browser stayed the foreground window and kept the keyboard, so the Person was looking at Vivid
 * and typing into the tab behind it. A window that already has the front is left alone, so one
 * that is being used never blinks.
 *
 * The instant of being topmost is kept after it. A window may always change its own place in the
 * stacking order, whoever holds the front, so if the system ever refuses the activation the
 * window is still the one on top. On macOS `app.focus({ steal: true })` is the system's own way
 * to come forward from behind another app; it does nothing more elsewhere.
 */
export function raiseMainWindow(
  platform: DesktopPlatform,
  window: Option.Option<BrowserWindow>,
): void {
  Option.match(window, {
    onNone: () => undefined,
    onSome: (available) => {
      if (available.isDestroyed()) return
      if (platform === 'win32' && !available.isFocused() && !available.isMinimized()) {
        available.minimize()
      }
      if (available.isMinimized()) available.restore()
      available.setAlwaysOnTop(true)
      available.show()
      available.moveTop()
      available.focus()
      available.setAlwaysOnTop(false)
      app.focus({ steal: true })
    },
  })
}
