import * as NodePath from 'node:path'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { BrowserWindow, ipcMain, screen, type Session } from 'electron'
import {
  NOTICE_INVOKE_CHANNEL,
  NOTICE_STATE_CHANNEL,
  NoticeRequest,
  NoticeState,
} from '../shared/notice.ts'

/**
 * The notice: "Vivid is using your computer", on screen for as long as a turn lasts.
 *
 * The vendored Computer draws its own status pill; the desktop draws and owns the notice beside
 * it. The reference shows a small always-on-top pill at the top centre of the screen
 * with the way to stop it (`~/codex-recon`, MAIN-PROCESS-ANALYSIS.md, "pill"); the placement and
 * the purpose are kept, the look is Vivid's own and is drawn by the web renderer
 * (`apps/web/src/notice.tsx`), so it uses the app's face, name, tokens and glass.
 *
 * What each window setting is for:
 * - `showInactive()` and never `focus()`: showing it must not take the keyboard from the app
 *   Vivid is working in, or Vivid's own typing would land in the notice. It is still focusable,
 *   so a Person who clicks it can then press Stop from the keyboard.
 * - `alwaysOnTop` at the `screen-saver` level: above ordinary and full-screen windows, where
 *   Windows allows it, so the way to stop Vivid is never covered by the app it is using.
 * - `skipTaskbar`, no frame, not resizable: it is a notice, not a second app window.
 * - `setContentProtection(true)`: Windows leaves the window out of screen captures, so the notice
 *   is never in a picture of the Person's window that goes to the model.
 * - `transparent`: the pill has its own rounded shape and shadow; the window is only its box.
 *
 * It is placed at the top centre of the primary display each time it comes up, and can be
 * dragged for the rest of that turn. Nothing about where it was is kept: the Computer's pointer
 * input is limited to the primary display, so that is where Vivid is working.
 */

/** The window is the pill plus room for its shadow, in device-independent pixels. */
const NOTICE_WIDTH = 420
const NOTICE_HEIGHT = 76
/** How far below the top of the work area the window sits. */
const NOTICE_TOP = 8

const decodeRequest = Schema.decodeUnknownOption(NoticeRequest, { onExcessProperty: 'error' })
const encodeState = Schema.encodeSync(NoticeState)

export interface NoticeDependencies {
  /** The app session: the notice is a page of the selected server's own bundled web build. */
  readonly session: Session
  /** The selected server's origin, when one is selected. Without one there is no notice page. */
  readonly origin: () => Option.Option<string>
  /** The Person pressed Stop on the notice. */
  readonly stop: () => void
}

/** Builds the window, hidden. It loads its page at once so the first turn does not wait for it. */
function build(dependencies: NoticeDependencies, origin: string): BrowserWindow {
  const window = new BrowserWindow({
    width: NOTICE_WIDTH,
    height: NOTICE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Vivid',
    webPreferences: {
      preload: NodePath.join(__dirname, '../preload/notice.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      session: dependencies.session,
    },
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setContentProtection(true)
  // The page never goes anywhere else and opens nothing.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  void window.loadURL(`${origin}/notice.html`).catch(() => {
    console.error('desktop: the notice could not be loaded')
  })
  return window
}

/**
 * Makes the notice. Nothing is created until the first state that shows something; `close`
 * destroys the window, which is done when the link to Vivid ends (a different server has a
 * different origin, and a signed-out app has nothing to say).
 */
export function createNotice(dependencies: NoticeDependencies) {
  let window = Option.none<BrowserWindow>()
  let state: NoticeState = NoticeState.cases.Hidden.make({})

  const live = () => Option.filter(window, (current) => !current.isDestroyed())
  const ensure = (): Option.Option<BrowserWindow> =>
    Option.orElse(live(), () => {
      window = Option.map(dependencies.origin(), (origin) => build(dependencies, origin))
      return window
    })
  /** Top centre of the primary display's work area, as it is now. */
  const place = (target: BrowserWindow): void => {
    const area = screen.getPrimaryDisplay().workArea
    target.setPosition(Math.round(area.x + (area.width - NOTICE_WIDTH) / 2), area.y + NOTICE_TOP)
  }

  // Only the notice's own main frame may ask. It can learn its state and stop Vivid; it has no
  // other request and no other channel.
  ipcMain.handle(NOTICE_INVOKE_CHANNEL, (event, payload) => {
    const trusted = Option.exists(
      live(),
      (current) =>
        current.webContents.id === event.sender.id && event.senderFrame === event.sender.mainFrame,
    )
    const request = trusted ? decodeRequest(payload) : Option.none()
    if (Option.exists(request, NoticeRequest.guards.Stop)) dependencies.stop()
    return encodeState(state)
  })

  return {
    /** Says what the notice shows now. `Hidden` takes it off the screen. */
    show: (next: NoticeState): void => {
      const wasHidden = NoticeState.guards.Hidden(state)
      state = next
      if (NoticeState.guards.Hidden(next)) {
        Option.map(live(), (current) => {
          current.webContents.send(NOTICE_STATE_CHANNEL, encodeState(next))
          current.hide()
        })
        return
      }
      Option.map(ensure(), (current) => {
        current.webContents.send(NOTICE_STATE_CHANNEL, encodeState(next))
        if (!wasHidden) return
        place(current)
        current.showInactive()
      })
    },
    /** Destroys the window. The next state that shows something builds a new one. */
    close: (): void => {
      state = NoticeState.cases.Hidden.make({})
      Option.map(live(), (current) => current.destroy())
      window = Option.none()
    },
  }
}
