import * as Option from 'effect/Option'
import * as NodeEvents from 'node:events'
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
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
