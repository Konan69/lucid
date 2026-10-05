import * as Option from 'effect/Option'
import * as NodeEvents from 'node:events'
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { DesktopPlatform } from '../shared/bridge.ts'

/** App zoom changes also reposition the native page viewport; Electron's zoom event covers wheels only. */
export const pageZoomChanges = new NodeEvents.EventEmitter<{ changed: [BrowserWindow] }>()

/** Follow Electron 44.4.3 role increments, then notify the window that owns native guest bounds. */
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
 * Put the window in front of another application's windows, for the one moment the Person is
 * somewhere else and Vivid has something for them: their browser has just signed them in.
 *
 * `focusMainWindow` is not enough there. It is right when the operating system has handed this
 * app the front, as it does for a second launch or a menu command. Here the browser holds the
 * front, and Windows refuses it to any process that does not (the rules of
 * `SetForegroundWindow`): `focus()` only makes the taskbar button flash, and the browser stays
 * on top of a window that has just signed in. This was seen on Windows 11 with the packaged app.
 *
 * A window may always change its own place in the stacking order, whoever holds the front. So it
 * is made topmost for an instant, which puts it above the browser, and let go at once so it does
 * not stay above everything else. `focus()` is still asked for, and is granted wherever the
 * system allows it. On macOS `app.focus({ steal: true })` is the system's own way to come
 * forward from behind another app; it does nothing more elsewhere.
 */
export function raiseMainWindow(window: Option.Option<BrowserWindow>): void {
  Option.match(window, {
    onNone: () => undefined,
    onSome: (available) => {
      if (available.isDestroyed()) return
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
