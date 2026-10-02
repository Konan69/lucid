import * as Option from 'effect/Option'
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { DesktopPlatform } from '../shared/bridge.ts'

/** App zoom changes also reposition the native page viewport; Electron's zoom event covers wheels only. */
export const pageZoomChanged = 'vivid-page-zoom-changed'

/** Follow Electron 44.4.3 role increments, then notify the window that owns native guest bounds. */
export function zoomPage(window: BrowserWindow, change: 'reset' | 'in' | 'out'): void {
  const level = window.webContents.getZoomLevel()
  window.webContents.setZoomLevel(change === 'reset' ? 0 : level + (change === 'in' ? 0.5 : -0.5))
  window.emit(pageZoomChanged)
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
      if (window !== undefined && 'webContents' in window) zoomPage(window, change)
    },
  }
}

/** Build standard menus from the injected host platform, with owned zoom geometry notifications. */
export function installApplicationMenu(platform: DesktopPlatform): void {
  const mac = platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [...(mac ? [] : [{ role: 'quit' as const }]), { role: 'close' }],
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
