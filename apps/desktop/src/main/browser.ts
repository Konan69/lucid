import * as NodeCrypto from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  WebContentsView,
  type BrowserWindow,
  type Session,
  type Event,
  type DownloadItem,
  type WebContents,
} from 'electron'
import {
  PageLoadFailure,
  PageFavicon,
  BrowserState,
  Page,
  Tab,
  PageDownloadRefused,
  PageMissing,
  PageAddressRefused,
  PageUnavailable,
  PageLimitReached,
  PagePositionInvalid,
  PageReopenEmpty,
  PageStorageClearFailed,
  PageCacheClearFailed,
  PagesRequest,
  PagesResponse,
  type PagesFailure,
} from '../shared/pages.ts'
import { AddressDecision, decideAddress, isPageAddress, type PageAddress } from './address.ts'
import { pageZoomChanges } from './menu.ts'
import { budgets } from './budgets.ts'
import {
  PageChange,
  emptyBrowserState,
  reducePages,
  browserSnapshot,
  type PageDisposition,
} from './pages.ts'
import {
  PagePresentation,
  PresentationChange,
  reducePresentation,
  sameShowing,
} from './presentation.ts'

/** Rejected loadURL promises follow did-fail-load; the event carries Chromium's real description. */
class PageLoadRejected extends Schema.TaggedError<PageLoadRejected>()(
  'PageLoadRejected',
  { tab: Tab },
  { title: 'Chromium page navigation was rejected' },
) {}

/** Convert typed text once before creating a guest or changing an existing navigation. */
const resolveAddress = Effect.fn('DesktopBrowser.resolveAddress')(function* (input: string) {
  return yield* AddressDecision.match<Effect.Effect<PageAddress, PageAddressRefused>>(
    decideAddress(input),
    {
      Navigate: ({ address }) => Effect.succeed(address),
      Search: ({ address }) => Effect.succeed(address),
      Refused: ({ reason }) => Effect.fail(new PageAddressRefused({ reason })),
    },
  )
})

/** Native host inputs are owned by main; the renderer supplies only decoded operations. */
export interface BrowserDependencies {
  readonly window: BrowserWindow
  readonly session: Session
  readonly publish: (state: BrowserState) => void
  readonly downloadRefused: (event: PageDownloadRefused) => void
  readonly run: (program: Effect.Effect<void>) => void
}

/**
 * Own the native guest lifecycle for one app window. State/listener ordering derives from the
 * reference desktop's preview/Manager.ts; hosting uses Electron's public WebContentsView API.
 * Guest views have no preload and never share the app's session or bridge authority.
 */
export class Browser {
  private state = emptyBrowserState
  private readonly views = new Map<Tab, WebContentsView>()
  private presentation: PagePresentation = PagePresentation.cases.Hidden.make({ generation: 0 })
  private attached = Option.none<WebContentsView>()
  private forgetting = false

  constructor(private readonly dependencies: BrowserDependencies) {
    this.secureSession()
    const reposition = (): void => this.reframe()
    dependencies.window.on('resize', reposition)
    dependencies.window.on('hide', () => this.invalidate('hidden'))
    dependencies.window.on('minimize', () => this.invalidate('hidden'))
    const menuZoomChanged = (window: BrowserWindow): void => {
      if (window === dependencies.window) this.reframe()
    }
    pageZoomChanges.on('changed', menuZoomChanged)
    dependencies.window.webContents.on('zoom-changed', () => setImmediate(reposition))
    // A replaced app document has no viewport lease; close guests before its new renderer loads.
    dependencies.window.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => {
      if (main && !inPlace) this.reset()
    })
    dependencies.window.once('closed', () => {
      pageZoomChanges.removeListener('changed', menuZoomChanged)
      this.reset()
      dependencies.session.removeListener('will-download', this.refuseDownload)
    })
  }

  /** Deny guest permissions and downloads before the first page can load. */
  private secureSession(): void {
    const pagesSession = this.dependencies.session
    pagesSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    pagesSession.setPermissionCheckHandler(() => false)
    pagesSession.setDevicePermissionHandler(() => false)
    // Electron 44.4.3 session docs: an empty streams object refuses getDisplayMedia.
    pagesSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    // Navigation includes subframes and server redirects; programmatic loads use this guard too.
    pagesSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const navigation = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
      callback({ cancel: navigation && !isPageAddress(details.url) })
    })
    pagesSession.on('will-download', this.refuseDownload)
  }

  /** Refuse before the next tick; attribution stays an opaque Tab, never a WebContents id. */
  private readonly refuseDownload = (
    event: Event,
    item: DownloadItem,
    contents: WebContents,
  ): void => {
    event.preventDefault()
    const owner = [...this.views.entries()].find(([, view]) => view.webContents === contents)
    if (owner === undefined) return
    this.dependencies.downloadRefused(
      PageDownloadRefused.make({
        tab: owner[0],
        address: item.getURL(),
        filename: item.getFilename(),
      }),
    )
  }

  /** Every transition publishes the complete ordered state, including background-page changes. */
  private change(change: PageChange): void {
    const next = reducePages(this.state, change)
    if (next === this.state) return
    if (!sameShowing(this.state.showing, next.showing)) this.invalidate('switch')
    this.state = next
    this.present()
    this.dependencies.publish(browserSnapshot(next))
  }

  /** Detach the old guest even when there is no replacement; hidden guests never cover app UI. */
  private detach(): void {
    Option.match(this.attached, {
      onNone: () => undefined,
      onSome: (view) => {
        const window = this.dependencies.window
        if (!window.isDestroyed()) {
          if (!view.webContents.isDestroyed() && view.webContents.isFocused())
            window.webContents.focus()
          window.contentView.removeChildView(view)
        }
        view.setVisible(false)
      },
    })
    this.attached = Option.none()
  }

  /** Revoke both presentation and native focus; later resize/zoom cannot reattach a stale lease. */
  private invalidate(reason: typeof PresentationChange.cases.Invalidate.Type.reason): void {
    this.presentation = reducePresentation(
      this.presentation,
      PresentationChange.cases.Invalidate.make({ reason }),
    )
    this.detach()
  }

  /** Native and preload viewport signals read the actual zoom, including programmatic changes. */
  private reframe(): void {
    if (this.dependencies.window.isDestroyed()) return
    this.presentation = reducePresentation(
      this.presentation,
      PresentationChange.cases.Reframe.make({
        scale: this.dependencies.window.webContents.getZoomFactor(),
      }),
    )
    this.present()
  }

  /** CSS coordinates scale into native DIP bounds; resize keeps the same browsing context. */
  private present(): void {
    const window = this.dependencies.window
    if (window.isDestroyed()) return
    const lease = this.presentation
    if (PagePresentation.guards.Hidden(lease)) {
      this.detach()
      return
    }
    const view = this.views.get(lease.owner)
    if (view === undefined || view.webContents.isDestroyed()) {
      this.invalidate('detached')
      return
    }
    const { rectangle, scale } = lease
    const { width: contentWidth, height: contentHeight } = window.getContentBounds()
    const x = Math.min(contentWidth, Math.round(rectangle.x * scale))
    const y = Math.min(contentHeight, Math.round(rectangle.y * scale))
    const width = Math.min(contentWidth - x, Math.round(rectangle.width * scale))
    const height = Math.min(contentHeight - y, Math.round(rectangle.height * scale))
    if (width <= 0 || height <= 0) {
      this.invalidate('detached')
      return
    }
    if (!Option.contains(this.attached, view)) {
      this.detach()
      window.contentView.addChildView(view)
      view.setVisible(true)
      this.attached = Option.some(view)
    }
    view.setBounds({ x, y, width, height })
  }

  /** Retained background guests have no keyboard or pointer authority while detached. */
  private ownsInput(tab: Tab, view: WebContentsView): boolean {
    return (
      PagePresentation.guards.Visible(this.presentation) &&
      this.presentation.owner === tab &&
      Option.contains(this.attached, view)
    )
  }

  /** Only live handles owned by this Browser may be driven. */
  private getView(tab: Tab): Effect.Effect<WebContentsView, PageMissing> {
    const view = this.views.get(tab)
    if (view === undefined || view.webContents.isDestroyed())
      return Effect.fail(new PageMissing({ tab }))
    return Effect.succeed(view)
  }

  /** Snapshot all native navigation flags together, preserving the reducer's current failure. */
  private sync(tab: Tab, view: WebContentsView): void {
    const contents = view.webContents
    const page = this.state.tabs.find((current) => current.tab === tab)
    if (contents.isDestroyed() || page === undefined) return
    const address = contents.getURL()
    this.change(
      PageChange.cases.Changed.make({
        page: Page.make({
          tab,
          // During main-frame loading getURL still names the previous document. Retain the requested
          // destination until commit, and the failed destination when Chromium renders its error page.
          address:
            isPageAddress(address) &&
            !contents.isLoadingMainFrame() &&
            PageLoadFailure.guards.None(page.failed)
              ? address
              : page.address,
          title: contents.getTitle(),
          favicon: page.favicon,
          loading: contents.isLoading(),
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
          failed: page.failed,
        }),
      }),
    )
  }

  /** Guard page-driven navigation and keep Chromium callbacks scoped to this handle. */
  private observe(tab: Tab, view: WebContentsView): void {
    const contents = view.webContents
    const sync = (): void => this.sync(tab, view)
    contents.on('will-frame-navigate', (event) => {
      if (!isPageAddress(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!isPageAddress(url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('before-input-event', (event) => {
      if (!this.ownsInput(tab, view)) event.preventDefault()
    })
    contents.on('before-mouse-event', (event) => {
      if (!this.ownsInput(tab, view)) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url, disposition, postBody }) => {
      if (isPageAddress(url) && postBody === undefined && this.views.size < budgets.pages)
        this.dependencies.run(
          this.popup(url, tab, disposition === 'background-tab' ? 'background' : 'foreground').pipe(
            Effect.asVoid,
            Effect.catchTags({
              PageAddressRefused: () => Effect.void,
              PageUnavailable: () => Effect.void,
              PageLimitReached: () => Effect.void,
              PageMissing: () => Effect.void,
            }),
          ),
        )
      return { action: 'deny' }
    })
    contents.on('did-start-navigation', (_event, address, inPlace, main) => {
      if (main && !inPlace && isPageAddress(address))
        this.change(PageChange.cases.Navigating.make({ tab, address }))
    })
    contents.on('did-fail-load', (...args) => {
      const [_event, code, reason, address, main] = args
      // ERR_ABORTED is normal for stop(), replaced loads, and refused downloads; subframes aren't tabs.
      if (!main || code === -3) return
      this.change(PageChange.cases.Failed.make({ tab, address, reason }))
    })
    contents.on('did-start-loading', sync)
    contents.on('did-stop-loading', sync)
    contents.on('did-navigate', sync)
    contents.on('did-navigate-in-page', sync)
    contents.on('page-title-updated', sync)
    contents.on('page-favicon-updated', (_event, icons) => {
      const icon = icons.find(isPageAddress)
      const favicon =
        icon === undefined
          ? PageFavicon.cases.None.make({})
          : PageFavicon.cases.Some.make({ value: icon })
      this.change(PageChange.cases.Favicon.make({ tab, favicon }))
    })
    contents.on('render-process-gone', (_event, details) => {
      const page = this.state.tabs.find((current) => current.tab === tab)
      if (page !== undefined)
        this.change(
          PageChange.cases.Failed.make({
            tab,
            address: page.address,
            reason: details.reason,
          }),
        )
    })
    contents.once('destroyed', () => {
      this.views.delete(tab)
      this.change(PageChange.cases.Closed.make({ tab }))
    })
  }

  /** Start loading without waiting for the site; did-fail-load owns user-visible failure state. */
  private load(tab: Tab, view: WebContentsView, address: PageAddress): void {
    this.change(PageChange.cases.Navigating.make({ tab, address }))
    this.dependencies.run(
      Effect.tryPromise({
        try: () => view.webContents.loadURL(address),
        catch: () => new PageLoadRejected({ tab }),
      }).pipe(Effect.catchTag('PageLoadRejected', () => Effect.void)),
    )
  }

  /** Mint the handle in main and create a sandboxed, preload-free guest before publishing it. */
  private readonly create = Effect.fn('DesktopBrowser.create')(function* (
    this: Browser,
    input: string,
    opened: (page: Page) => PageChange,
  ) {
    const address = yield* resolveAddress(input)
    if (this.forgetting || this.dependencies.window.isDestroyed())
      return yield* new PageUnavailable({})
    if (this.views.size >= budgets.pages)
      return yield* new PageLimitReached({ limit: budgets.pages })
    const tab = Tab.make(NodeCrypto.randomUUID())
    const view = yield* Effect.try({
      try: () =>
        new WebContentsView({
          webPreferences: {
            session: this.dependencies.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            webSecurity: true,
            webviewTag: false,
          },
        }),
      catch: () => new PageUnavailable({}),
    })
    this.views.set(tab, view)
    this.observe(tab, view)
    this.change(
      opened(
        Page.make({
          tab,
          address,
          title: view.webContents.getTitle(),
          favicon: PageFavicon.cases.None.make({}),
          loading: true,
          canGoBack: false,
          canGoForward: false,
          failed: PageLoadFailure.cases.None.make({}),
        }),
      ),
    )
    this.load(tab, view, address)
    return PagesResponse.cases.Opened.make({ tab })
  })

  /** New renderer pages append and select; admission is shared with duplicate/reopen/popup. */
  private open(address: string) {
    return this.create(address, (page) => PageChange.cases.Opened.make({ page }))
  }

  /** Popup URL recreation has an internal opener and explicit selection intent, without adoption. */
  private readonly popup = Effect.fn('DesktopBrowser.popup')(function* (
    this: Browser,
    address: string,
    opener: Tab,
    disposition: PageDisposition,
  ) {
    yield* this.getView(opener)
    return yield* this.create(address, (page) =>
      PageChange.cases.Popup.make({ page, opener, disposition }),
    )
  })

  /** Clone only the current URL into a fresh context, adjacent to the source page. */
  private readonly duplicate = Effect.fn('DesktopBrowser.duplicate')(function* (
    this: Browser,
    tab: Tab,
  ) {
    yield* this.getView(tab)
    const page = this.state.tabs.find((current) => current.tab === tab)
    if (page === undefined) return yield* new PageMissing({ tab })
    return yield* this.create(page.address, (created) =>
      PageChange.cases.Duplicated.make({ tab, duplicate: created.tab }),
    )
  })

  /** Consume a close descriptor only after successful native admission; a cap refusal retains it. */
  private readonly reopen = Effect.fn('DesktopBrowser.reopen')(function* (this: Browser) {
    const closed = this.state.closed.at(-1)
    if (closed === undefined) return yield* new PageReopenEmpty({})
    return yield* this.create(closed.page.address, (page) =>
      PageChange.cases.Reopened.make({ tab: page.tab }),
    )
  })

  /** Refuse invalid final indexes before the reducer changes order. */
  private readonly move = Effect.fn('DesktopBrowser.move')(function* (
    this: Browser,
    tab: Tab,
    to: number,
  ) {
    yield* this.getView(tab)
    if (to >= this.state.tabs.length) return yield* new PagePositionInvalid({ tab, to })
    this.change(PageChange.cases.Moved.make({ tab, to }))
    return PagesResponse.cases.Done.make({})
  })

  /** Publish one complete state change before releasing every non-surviving guest. */
  private closeOthers(tab: Tab): void {
    const removed = [...this.views.entries()].filter(([current]) => current !== tab)
    this.change(PageChange.cases.CloseOthers.make({ tab }))
    for (const [current, view] of removed) {
      this.views.delete(current)
      view.webContents.close({ waitForBeforeUnload: false })
    }
  }

  /** Destroy even pages with beforeunload handlers; their scripts cannot veto a panel close. */
  private close(tab: Tab, view: WebContentsView): void {
    this.change(PageChange.cases.Closed.make({ tab }))
    this.views.delete(tab)
    view.webContents.close({ waitForBeforeUnload: false })
  }

  /** Window close, document replacement, server change, and explicit sign-out release every guest. */
  reset(): void {
    this.invalidate('detached')
    const views = [...this.views.values()]
    this.views.clear()
    this.change(PageChange.cases.Reset.make({}))
    for (const view of views) {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    }
  }

  /** Block new guests until cookies/storage and cache finish clearing, so tabs cannot repopulate them. */
  private readonly forget = Effect.fn('DesktopBrowser.forget')(function* (this: Browser) {
    if (this.forgetting) return yield* new PageUnavailable({})
    this.forgetting = true
    this.reset()
    return yield* this.clearData().pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.forgetting = false
        }),
      ),
    )
  })

  /** Only the dedicated pages Session is cleared; app session/cookies never enter this adapter. */
  private readonly clearData = Effect.fn('DesktopBrowser.clearData')(function* (this: Browser) {
    yield* Effect.tryPromise({
      try: () =>
        this.dependencies.session.clearData({
          dataTypes: [
            'cookies',
            'localStorage',
            'indexedDB',
            'serviceWorkers',
            'fileSystems',
            'webSQL',
            'backgroundFetch',
          ],
        }),
      catch: () => new PageStorageClearFailed({}),
    })
    yield* Effect.tryPromise({
      try: () => this.dependencies.session.clearCache(),
      catch: () => new PageCacheClearFailed({}),
    })
    return PagesResponse.cases.Done.make({})
  })

  /** Resolve before driving the handle, so refused input leaves the current page untouched. */
  private readonly go = Effect.fn('DesktopBrowser.go')(function* (
    this: Browser,
    tab: Tab,
    address: string,
  ) {
    const destination = yield* resolveAddress(address)
    return yield* this.drive(tab, (view) => this.load(tab, view, destination))
  })

  /** Decode occurred in the shared bridge; this exhaustive adapter dispatches only owned handles. */
  readonly handle = Effect.fn('DesktopBrowser.handle')(function* (
    this: Browser,
    request: PagesRequest,
  ) {
    return yield* PagesRequest.match<Effect.Effect<PagesResponse, PagesFailure>>(request, {
      Open: ({ address }) => this.open(address),
      Move: ({ tab, to }) => this.move(tab, to),
      Duplicate: ({ tab }) => this.duplicate(tab),
      Reopen: () => this.reopen(),
      CloseOthers: ({ tab }) => this.drive(tab, () => this.closeOthers(tab)),
      Reframe: () =>
        Effect.sync(() => {
          this.reframe()
          return PagesResponse.cases.Done.make({})
        }),
      Get: () =>
        Effect.succeed(PagesResponse.cases.State.make({ value: browserSnapshot(this.state) })),
      Place: ({ placement }) =>
        Effect.sync(() => {
          this.presentation = reducePresentation(
            this.presentation,
            PresentationChange.cases.Place.make({
              placement,
              owner: this.state.showing,
              scale: this.dependencies.window.webContents.getZoomFactor(),
            }),
          )
          this.present()
          return PagesResponse.cases.Done.make({})
        }),
      Reset: () =>
        Effect.sync(() => {
          this.reset()
          return PagesResponse.cases.Done.make({})
        }),
      Forget: () => this.forget(),
      Show: ({ tab }) => this.drive(tab, () => this.change(PageChange.cases.Shown.make({ tab }))),
      Close: ({ tab }) => this.drive(tab, (view) => this.close(tab, view)),
      Go: ({ tab, address }) => this.go(tab, address),
      Back: ({ tab }) =>
        this.drive(tab, (view) => {
          if (view.webContents.navigationHistory.canGoBack())
            view.webContents.navigationHistory.goBack()
        }),
      Forward: ({ tab }) =>
        this.drive(tab, (view) => {
          if (view.webContents.navigationHistory.canGoForward())
            view.webContents.navigationHistory.goForward()
        }),
      Reload: ({ tab }) => this.drive(tab, (view) => view.webContents.reload()),
      Stop: ({ tab }) => this.drive(tab, (view) => view.webContents.stop()),
    })
  })

  /** Native synchronous failures are adapter errors; unknown/stale handles stay PageMissing. */
  private readonly drive = Effect.fn('DesktopBrowser.drive')(function* (
    this: Browser,
    tab: Tab,
    action: (view: WebContentsView) => void,
  ) {
    const view = yield* this.getView(tab)
    yield* Effect.try({ try: () => action(view), catch: () => new PageUnavailable({}) })
    return PagesResponse.cases.Done.make({})
  })
}
