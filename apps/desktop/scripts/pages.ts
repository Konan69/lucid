import * as NodeAssert from 'node:assert/strict'
import * as NodeProcess from 'node:process'
import * as NodeEvents from 'node:events'
import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  webContents,
  type WebContents,
  type View,
} from 'electron'
import { Effect, Schema } from 'effect'
import { Browser } from '../src/main/browser.ts'
import { DeviceLink } from '../src/shared/device.ts'
import { registerBridge, sendBridgeEvent, type BridgeRuntime } from '../src/main/bridge.ts'
import { DesktopSettings } from '../src/main/settings.ts'
import { ServerSettings, SettingsSaveFailed } from '../src/shared/settings.ts'
import { zoomPage } from '../src/main/menu.ts'
import { BridgeRequest, BridgeEvent } from '../src/shared/bridge.ts'
import {
  PagesRequest,
  PagesResponse,
  Tab,
  ShowingTab,
  type BrowserState,
} from '../src/shared/pages.ts'

// Keep Electron's tests independent of the developer's profile and service endpoints.
const profile = NodeProcess.argv[2]
const preload = NodeProcess.argv[3]
if (profile === undefined || preload === undefined)
  throw new Error('An isolated profile and preload are required')
app.setPath('userData', profile)

const decodeTab = Schema.decodeUnknownEffect(Tab)

/** The standalone IPC entry runs the production bridge program outside test orchestration. */
const runtime: BridgeRuntime = {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone native IPC entry.
  run: (program) => Effect.runPromise(program),
}

/** Chooser authority is outside this proof; unrelated writes fail and the sender admits only pages. */
const settings = DesktopSettings.of({
  get: Effect.succeed(ServerSettings.cases.NoServer.make({})),
  set: () => Effect.fail(new SettingsSaveFailed({})),
  forget: Effect.fail(new SettingsSaveFailed({})),
})

/** Native callbacks use the standalone test runtime, exactly like main's Electron adapter. */
function runPopup(program: Effect.Effect<void>): void {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone Electron test event adapter.
  void Effect.runPromise(program)
}

/** Await a committed document receipt before fixture readiness or subsequent guest commands. */
function loaded(contents: WebContents) {
  return Effect.callback<void>((resume) => {
    if (!contents.isLoading()) return resume(Effect.void)
    const ready = (): void => resume(Effect.void)
    contents.once('did-stop-loading', ready)
    return Effect.sync(() => contents.removeListener('did-stop-loading', ready))
  })
}

/** Exercise the real sandboxed preload and IPC; native handles return through the public bridge. */
function renderer(window: BrowserWindow, expression: string) {
  return Effect.promise(() => window.webContents.executeJavaScript(expression))
}

/** A bounds receipt proves viewport refresh, without sleeps or repeated geometry sampling. */
function changedBounds(view: View, action: () => void) {
  return Effect.callback<void>((resume) => {
    const changed = (): void => resume(Effect.void)
    view.once('bounds-changed', changed)
    action()
    return Effect.sync(() => view.removeListener('bounds-changed', changed))
  })
}

/**
 * The guests the window is drawing. A guest stays a child of the window for as long as its page is
 * open and is hidden in place, so being a child says nothing; being visible is the fact.
 */
const shown = (window: BrowserWindow) =>
  window.contentView.children.filter((child) => child.getVisible())

/**
 * Waits until the guest's own document says it is being drawn. Counting the window's children
 * passed for a guest that had been taken off the window and put back, which Electron 44.4.3
 * leaves hidden: the proof was green while every page after the first was a blank panel.
 */
const drawn = (view: WebContentsView) =>
  Effect.promise(() =>
    view.webContents.executeJavaScript(
      `new Promise((resolve) => {
        if (document.visibilityState === 'visible') return resolve(true)
        document.addEventListener('visibilitychange', () => resolve(true), { once: true })
      })`,
    ),
  )

/** Menu and programmatic zoom reuse the current view; revoked leases stay hidden. */
const geometry = Effect.fn('NativePages.geometry')(function* (window: BrowserWindow, tab: Tab) {
  yield* renderer(window, `window.vivid.pages.show(${JSON.stringify(tab)})`)
  yield* renderer(window, 'window.vivid.pages.place({x:10,y:20,width:100,height:200})')
  const visible = shown(window)[0]
  if (!(visible instanceof WebContentsView)) return yield* Effect.die('Expected attached guest')
  zoomPage(window, 'in')
  const zoom = window.webContents.getZoomFactor()
  // The expected bounds below are computed from this reading, so a menu zoom that did nothing
  // would read 1 and pass on the bounds the page already had.
  NodeAssert.ok(zoom > 1, `zoom ${zoom}`)
  NodeAssert.deepEqual(visible.getBounds(), {
    x: Math.round(10 * zoom),
    y: Math.round(20 * zoom),
    width: Math.round(100 * zoom),
    height: Math.round(200 * zoom),
  })
  yield* changedBounds(visible, () => window.webContents.setZoomFactor(1.5))
  NodeAssert.deepEqual(visible.getBounds(), { x: 15, y: 30, width: 150, height: 300 })
  yield* renderer(window, 'window.vivid.pages.place({x:10,y:20,width:900,height:200})')
  yield* changedBounds(visible, () => window.setContentSize(640, 480))
  NodeAssert.equal(shown(window)[0], visible)
  NodeAssert.equal(visible.getBounds().width, 625)
  yield* renderer(window, "window.vivid.pages.place('hidden')")
  window.webContents.setZoomFactor(1)
  yield* renderer(window, 'new Promise(resolve => requestAnimationFrame(() => resolve(true)))')
  NodeAssert.equal(shown(window).length, 0)
  yield* renderer(window, 'window.vivid.pages.place({x:10,y:20,width:100,height:200})')
  NodeAssert.equal(shown(window)[0], visible)
  // Shown again after being hidden is the case that was broken: the document must be drawn.
  yield* drawn(visible)
  window.hide()
  NodeAssert.equal(shown(window).length, 0)
  window.show()
  return yield* Effect.void
})

/** Public renderer operations preserve order, reject bad positions and return fresh handles. */
const operations = Effect.fn('NativePages.operations')(function* (
  window: BrowserWindow,
  browser: Browser,
  tab: Tab,
) {
  const duplicate = yield* decodeTab(
    yield* renderer(window, `window.vivid.pages.duplicate(${JSON.stringify(tab)})`),
  )
  NodeAssert.notEqual(duplicate, tab)
  // Selection revoked the prior slot, even though the source's native context remains warm.
  NodeAssert.equal(shown(window).length, 0)
  yield* renderer(window, `window.vivid.pages.move({tab:${JSON.stringify(duplicate)},to:0})`)
  const invalid = yield* browser
    .handle(PagesRequest.cases.Move.make({ tab, to: 2 }))
    .pipe(Effect.flip)
  NodeAssert.equal(invalid._tag, 'PagePositionInvalid')
  const rejected = yield* renderer(
    window,
    `window.vivid.pages.move({tab:${JSON.stringify(tab)},to:2}).then(() => false, () => true)`,
  )
  NodeAssert.equal(rejected, true)
  yield* renderer(window, `window.vivid.pages.close(${JSON.stringify(duplicate)})`)
  const reopened = yield* decodeTab(yield* renderer(window, 'window.vivid.pages.reopen()'))
  NodeAssert.notEqual(reopened, duplicate)
  const state = yield* browser.handle(PagesRequest.cases.Get.make({}))
  if (!PagesResponse.guards.State(state)) return yield* Effect.die('Expected snapshot')
  NodeAssert.deepEqual(
    state.value.tabs.map((page) => page.tab),
    [reopened, tab],
  )
  yield* renderer(window, `window.vivid.pages.closeOthers(${JSON.stringify(tab)})`)
  return yield* Effect.void
})

/** Observe a whole native snapshot receipt before checking popup placement and selection. */
function popupReceipt(input: {
  readonly events: NodeEvents.EventEmitter<{ state: [BrowserState] }>
  readonly guest: WebContents
  readonly modifiers: ReadonlyArray<string>
  readonly button: 'left' | 'middle'
  readonly after: number
}) {
  return Effect.callback<BrowserState>((resume) => {
    const changed = (state: BrowserState): void => {
      if (state.tabs.length === 2 && state.revision > input.after) {
        input.events.removeListener('state', changed)
        resume(Effect.succeed(state))
      }
    }
    input.events.on('state', changed)
    input.guest.sendInputEvent({
      type: 'mouseDown',
      x: 20,
      y: 20,
      button: input.button,
      clickCount: 1,
      modifiers: [...input.modifiers],
    })
    input.guest.sendInputEvent({
      type: 'mouseUp',
      x: 20,
      y: 20,
      button: input.button,
      clickCount: 1,
      modifiers: [...input.modifiers],
    })
    return Effect.sync(() => input.events.removeListener('state', changed))
  })
}

/** Capture the authoritative revision before an action; queued older IPC snapshots cannot satisfy it. */
const snapshot = Effect.fn('NativePages.snapshot')(function* (browser: Browser) {
  const response = yield* browser.handle(PagesRequest.cases.Get.make({}))
  if (!PagesResponse.guards.State(response)) return yield* Effect.die('Expected native snapshot')
  return response.value
})

/** Real link clicks establish Chromium disposition; foreground script popups use the same adapter. */
const popups = Effect.fn('NativePages.popups')(function* (input: {
  readonly browser: Browser
  readonly window: BrowserWindow
  readonly events: NodeEvents.EventEmitter<{ state: [BrowserState] }>
  readonly tab: Tab
  readonly guest: WebContents
}) {
  yield* loaded(input.guest)
  yield* renderer(input.window, 'window.vivid.pages.place({x:0,y:0,width:600,height:400})')
  input.guest.focus()
  for (const intent of [
    { button: 'left', modifiers: ['control'] },
    { button: 'middle', modifiers: [] },
  ] as const) {
    const before = yield* snapshot(input.browser)
    const background = yield* popupReceipt({
      events: input.events,
      guest: input.guest,
      after: before.revision,
      ...intent,
    })
    NodeAssert.deepEqual(background.tabs.map((page) => page.tab).slice(0, 1), [input.tab])
    NodeAssert.deepEqual(background.showing, ShowingTab.cases.Some.make({ value: input.tab }))
    yield* input.browser.handle(PagesRequest.cases.CloseOthers.make({ tab: input.tab }))
  }
  const beforeForeground = yield* snapshot(input.browser)
  const foreground = yield* Effect.callback<BrowserState>((resume) => {
    const changed = (state: BrowserState): void => {
      if (state.tabs.length === 2 && state.revision > beforeForeground.revision) {
        input.events.removeListener('state', changed)
        resume(Effect.succeed(state))
      }
    }
    input.events.on('state', changed)
    runPopup(
      Effect.promise(() =>
        input.guest.executeJavaScript('window.open("https://fixture.example/popup"); true'),
      ).pipe(Effect.asVoid),
    )
    return Effect.sync(() => input.events.removeListener('state', changed))
  })
  NodeAssert.deepEqual(foreground.tabs.map((page) => page.tab).slice(0, 1), [input.tab])
  // The popup sits beside its opener and is the page in front. The page is added and selected in
  // one change (`src/main/pages.ts` `Popup`), so the first state with two pages already says so.
  const popup = foreground.tabs[1]
  if (popup === undefined) return yield* Effect.die('Expected the popup beside its opener')
  NodeAssert.deepEqual(foreground.showing, ShowingTab.cases.Some.make({ value: popup.tab }))
  NodeAssert.equal(shown(input.window).length, 0)
})

/**
 * A transient profile and production preload exercise native ownership. The standalone Electron
 * process owns the window: both terminal callbacks call app.exit, before the parent removes its profile.
 */
const proof = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.promise(() => app.whenReady())
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload },
    })
    const guests = session.fromPartition(`vivid-test-${crypto.randomUUID()}`)
    guests.protocol.handle(
      'https',
      () =>
        new Response(
          '<title>Fixture</title><a href="https://fixture.example/target" target="_blank" style="position:fixed;left:0;top:0;width:100px;height:100px">Open</a>',
          { headers: { 'Content-Type': 'text/html' } },
        ),
    )
    const events = new NodeEvents.EventEmitter<{ state: [BrowserState] }>()
    const browser = new Browser({
      window,
      session: guests,
      stopVivid: () => {},
      mayOpen: () => Effect.succeed(true),
      publish: (state) => {
        // Renderer IPC is asynchronous. Deliver fixture receipts after the native operation returns,
        // so a receipt cannot re-enter create/close while it still owns its Effect continuation.
        queueMicrotask(() => events.emit('state', state))
        if (!window.webContents.isDestroyed())
          sendBridgeEvent(window.webContents, BridgeEvent.cases.PagesChanged.make({ value: state }))
      },
      downloadRefused: () => {},
      run: runPopup,
    })
    registerBridge({
      handlers: {
        pages: (request) => browser.handle(request),
        getAppVersion: () => 'test',
        device: { state: () => DeviceLink.cases.SignedOut.make({}), wake: () => {} },
        settings,
        onServerChanged: () => {},
        openExternal: () => Effect.void,
      },
      runtime,
      isTrustedSender: (id, _url, request) =>
        id === window.webContents.id && BridgeRequest.guards.Pages(request),
    })
    yield* Effect.promise(() => window.loadURL('data:text/html,<title>Vivid test</title>'))
    window.show()
    const start = webContents.getAllWebContents().length
    for (let index = 0; index < 12; index++)
      yield* browser.handle(PagesRequest.cases.Open.make({ address: 'https://fixture.example/' }))
    // All native documents must commit before suite readiness; test commands never race guest startup.
    const contents = webContents.getAllWebContents().filter((current) => current.session === guests)
    yield* Effect.forEach(contents, loaded, { concurrency: 'unbounded' })
    yield* Effect.callback<void>((resume) => {
      NodeProcess.stdin.once('data', () => resume(Effect.void))
      console.log('Vivid native pages ready')
    })
    const refusal = yield* browser
      .handle(PagesRequest.cases.Open.make({ address: 'https://fixture.example/' }))
      .pipe(Effect.flip)
    NodeAssert.equal(refusal._tag, 'PageLimitReached')
    NodeAssert.equal(webContents.getAllWebContents().length - start, 12)
    const emptyHistory = yield* browser.handle(PagesRequest.cases.Reopen.make({})).pipe(Effect.flip)
    NodeAssert.equal(emptyHistory._tag, 'PageReopenEmpty')
    const state = yield* browser.handle(PagesRequest.cases.Get.make({}))
    if (!PagesResponse.guards.State(state)) return yield* Effect.die('Expected state')
    const first = state.value.tabs[0]
    if (first === undefined) return yield* Effect.die('Expected first tab')
    const duplicateRefused = yield* browser
      .handle(PagesRequest.cases.Duplicate.make({ tab: first.tab }))
      .pipe(Effect.flip)
    NodeAssert.equal(duplicateRefused._tag, 'PageLimitReached')
    yield* browser.handle(PagesRequest.cases.CloseOthers.make({ tab: first.tab }))
    yield* browser.handle(
      PagesRequest.cases.Place.make({ placement: { x: 0, y: 0, width: 600, height: 400 } }),
    )
    const visible = shown(window)[0]
    if (!(visible instanceof WebContentsView)) return yield* Effect.die('Expected retained view')
    const guest = visible.webContents
    guest.focus()
    const capture = yield* Effect.promise(() =>
      guest.executeJavaScript(
        'navigator.mediaDevices.getDisplayMedia({video:true}).then(() => "allowed", error => error.name)',
        true,
      ),
    )
    NodeAssert.equal(capture, 'NotAllowedError')
    yield* geometry(window, first.tab)
    yield* operations(window, browser, first.tab)
    yield* popups({ browser, window, events, tab: first.tab, guest })
    console.log('Vivid native pages proof passed')
    return yield* Effect.void
  }),
)

// Standalone Electron test executable: this runtime never enters application server/library code.
// oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone Electron test executable entry.
void Effect.runPromise(proof).then(
  () => app.exit(0),
  (cause) => {
    console.error(cause)
    app.exit(1)
  },
)
