import * as Option from 'effect/Option'
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { DesktopPlatform } from '../shared/bridge.ts'

/** Build the standard role-only menu from the injected host platform. */
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
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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
