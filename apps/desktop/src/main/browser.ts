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
  ShowingTab,
  PageLoadFailure,
  BrowserState,
  Page,
  Tab,
  PageDownloadRefused,
  PageMissing,
  PageAddressRefused,
  PageUnavailable,
  PageStorageClearFailed,
  PageCacheClearFailed,
  PagesRequest,
  PagesResponse,
  type PagesFailure,
  type PagePlacement,
} from '../shared/pages.ts'
import { AddressDecision, decideAddress, isPageAddress, type PageAddress } from './address.ts'
import { PageChange, emptyBrowserState, reducePages } from './pages.ts'

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
  private placement: PagePlacement = 'hidden'
  private attached = Option.none<WebContentsView>()
  private forgetting = false

  constructor(private readonly dependencies: BrowserDependencies) {
    this.secureSession()
    const reposition = (): void => this.present()
    dependencies.window.on('resize', reposition)
    dependencies.window.webContents.on('zoom-changed', () => setImmediate(reposition))
    // A replaced app document has no viewport lease; close guests before its new renderer loads.
    dependencies.window.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => {
      if (main && !inPlace) this.reset()
    })
    dependencies.window.once('closed', () => {
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
    this.state = next
    this.present()
    this.dependencies.publish(next)
  }

  /** Detach the old guest even when there is no replacement; hidden guests never cover app UI. */
  private detach(): void {
    Option.match(this.attached, {
      onNone: () => undefined,
      onSome: (view) => {
        if (!this.dependencies.window.isDestroyed())
          this.dependencies.window.contentView.removeChildView(view)
      },
    })
    this.attached = Option.none()
  }

  /** CSS coordinates scale by app zoom into native DIP bounds, clipped to the content area. */
  private present(): void {
    const window = this.dependencies.window
    if (window.isDestroyed()) return
    const view = ShowingTab.match(this.state.showing, {
      None: () => Option.none<WebContentsView>(),
      Some: ({ value: tab }) => Option.fromNullishOr(this.views.get(tab)),
    })
    if (this.placement === 'hidden' || Option.isNone(view)) {
      this.detach()
      return
    }
    const zoom = window.webContents.getZoomFactor()
    const { width: contentWidth, height: contentHeight } = window.getContentBounds()
    const x = Math.min(contentWidth, Math.round(this.placement.x * zoom))
    const y = Math.min(contentHeight, Math.round(this.placement.y * zoom))
    const width = Math.min(contentWidth - x, Math.round(this.placement.width * zoom))
    const height = Math.min(contentHeight - y, Math.round(this.placement.height * zoom))
    if (width <= 0 || height <= 0) {
      this.detach()
      return
    }
    if (!Option.contains(this.attached, view.value)) {
      this.detach()
      window.contentView.addChildView(view.value)
      this.attached = view
    }
    view.value.setBounds({ x, y, width, height })
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
    contents.setWindowOpenHandler(({ url }) => {
      if (isPageAddress(url))
        this.dependencies.run(
          this.open(url).pipe(
            Effect.asVoid,
            Effect.catchTags({
              PageAddressRefused: () => Effect.void,
              PageUnavailable: () => Effect.void,
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
  private readonly open = Effect.fn('DesktopBrowser.open')(function* (
    this: Browser,
    input: string,
  ) {
    const address = yield* resolveAddress(input)
    if (this.forgetting || this.dependencies.window.isDestroyed())
      return yield* new PageUnavailable({})
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
      PageChange.cases.Opened.make({
        page: Page.make({
          tab,
          address,
          title: view.webContents.getTitle(),
          loading: true,
          canGoBack: false,
          canGoForward: false,
          failed: PageLoadFailure.cases.None.make({}),
        }),
      }),
    )
    this.load(tab, view, address)
    return PagesResponse.cases.Opened.make({ tab })
  })

  /** Destroy even pages with beforeunload handlers; their scripts cannot veto a panel close. */
  private close(tab: Tab, view: WebContentsView): void {
    this.change(PageChange.cases.Closed.make({ tab }))
    this.views.delete(tab)
    view.webContents.close({ waitForBeforeUnload: false })
  }

  /** Window close, document replacement, server change, and explicit sign-out release every guest. */
  reset(): void {
    this.placement = 'hidden'
    this.detach()
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
      Get: () => Effect.succeed(PagesResponse.cases.State.make({ value: this.state })),
      Place: ({ placement }) =>
        Effect.sync(() => {
          this.placement = placement
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
