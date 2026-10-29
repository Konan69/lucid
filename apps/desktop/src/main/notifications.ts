import * as Option from 'effect/Option'
import { Notification, type BrowserWindow } from 'electron'
import { BridgeEvent, type DesktopNotification } from '../shared/bridge.ts'
import { sendBridgeEvent } from './bridge.ts'
import { focusMainWindow } from './menu.ts'

/**
 * The system's notifications, for the desktop app.
 *
 * Electron has no Web Push, so a closed app hears nothing; while it runs, its page hears each new
 * notification on its live list and hands it here (`ShowNotification`). It is shown only while
 * the window is not in front: in front, the page says it at the foot of the window itself. Pressing
 * it brings the window forward and tells the page which Thread it was about.
 *
 * Each notification is held until it is pressed or closed, so nothing collects it, and its click
 * handler with it, while it is still on screen.
 */
export function createNotifications(window: () => Option.Option<BrowserWindow>) {
  const showing = new Set<Notification>()
  return (notification: DesktopNotification): void => {
    if (!Notification.isSupported()) return
    Option.map(window(), (open) => {
      if (open.isFocused()) return
      const shown = new Notification({ title: notification.title, body: notification.body })
      showing.add(shown)
      shown.on('close', () => showing.delete(shown))
      shown.on('click', () => {
        showing.delete(shown)
        if (open.isDestroyed()) return
        // Pressing a notification hands this app the front, as a second launch does.
        focusMainWindow(Option.some(open))
        sendBridgeEvent(
          open.webContents,
          BridgeEvent.cases.NotificationOpened.make({ threadId: notification.threadId }),
        )
      })
      shown.show()
    })
  }
}
