# @vivid/desktop

Electron shell for the Vivid web app. It connects to a Vivid server the Person chooses; it never
starts a server, database, or runtime. The shell serves its own bundled web build at the chosen
origin and forwards only `/api*` and `/health` to the chosen server. Product UI stays in the web
renderer. Until the shell loads the server's own build, release the shell and server together:
a server-side web-client fix does not update desktop, and mismatched versions may use incompatible
API contracts. The health probe verifies service identity, not version compatibility.

## Build

```sh
flock /tmp/vivid-tsc.lock pnpm --filter @vivid/web build
pnpm --filter @vivid/desktop build
pnpm --filter @vivid/desktop dist --dir
```

The build stages the web assets under `dist/renderer` and bundles main and sandboxed preload as
CommonJS. Packaging copies the assets to `web/dist` under Electron's resources directory. Signing
and updates require release configuration; no updater is installed.

## Choosing a server

First launch opens the local `chooser.html`, with no default server and no network authority.
Enter the origin of a remote or local Vivid server. Remote servers require HTTPS; HTTP is allowed
for localhost, loopback and private IP addresses. Credentials, paths, queries and fragments are
rejected. Main probes `/health` for `{ "ok": true, "service": "vivid" }` with a three-second timeout,
without cookies or redirects. Only a verified server is saved.

`settings.json` in Electron's user data directory stores version 2 and the tagged server state.
Writes use an exclusive temporary file, fsync and atomic rename before updating memory. Damaged
or unreadable settings show the chooser and are moved beside the original with a `.damaged`
suffix; earlier backups are preserved. If directory permissions prevent moving the file, the
original remains untouched and startup still shows the chooser. Existing valid version 1 explicit
selections are read. Forgetting a server durably records `NoServer` and returns to the chooser.

Main loads `dist/renderer/chooser.html` in development and `web/dist/chooser.html` under the
packaged resources directory. Put the chooser source in the web build's public assets as
`apps/web/public/chooser.html` to use the existing staging pipeline. Its UI belongs to the renderer
owner. The shell uses the same saved origin and staged assets in development and production;
`VIVID_DESKTOP_RENDERER_URL` is no longer used.

Import bridge types from `@vivid/desktop/bridge` (`src/shared/bridge.ts`). The chooser receives
`window.vivid` with `VividDesktopBridge`; selected-server documents receive `VividAppBridge`,
containing `getAppVersion()` and `pages`:

```ts
interface VividDesktopBridge {
  readonly pages: VividPagesBridge
  server: {
    get(): Promise<{ _tag: 'NoServer' } | { _tag: 'Server'; origin: string }>
    choose(
      origin: string,
    ): Promise<{ _tag: 'Chosen' } | { _tag: 'Unreachable'; reason: string } | { _tag: 'NotVivid' }>
    forget(): Promise<void>
  }
  getAppVersion(): Promise<string>
  openExternal(url: string): Promise<void>
}
```

Invalid arguments and persistence failures reject the call. The chooser should display them and
stay open; `Chosen` means both probe and durable save succeeded, and main replaces the document.
No IPC channel, filesystem, credential or app-cookie authority is exposed.

## Browser panel bridge

The app renderer receives this exact surface on `window.vivid`. Import `Tab`, `PageInput`,
`PagePlacement`, `BrowserState`, `PageDownloadRefused`, and `VividAppBridge` from the bridge export.
The renderer owns the panel, tab row, address input, and sign-out integration.

```ts
type VividAppBridge = Pick<VividDesktopBridge, 'getAppVersion' | 'pages'>

interface VividPagesBridge {
  readonly open: (input: PageInput) => Promise<Tab>
  readonly show: (tab: Tab) => Promise<void>
  readonly close: (tab: Tab) => Promise<void>
  readonly go: (input: { readonly tab: Tab; readonly address: string }) => Promise<void>
  readonly back: (tab: Tab) => Promise<void>
  readonly forward: (tab: Tab) => Promise<void>
  readonly reload: (tab: Tab) => Promise<void>
  readonly stop: (tab: Tab) => Promise<void>
  readonly place: (placement: PagePlacement) => Promise<void>
  readonly watch: (listener: (state: BrowserState) => void) => () => void
  readonly watchDownloads: (listener: (event: PageDownloadRefused) => void) => () => void
  readonly reset: () => Promise<void>
  readonly forget: () => Promise<void>
}
```

`Tab` is a branded opaque string minted by main. `PageInput` is `{ readonly address: string }`.
`PagePlacement` is `'hidden'` or `{ readonly x: number; readonly y: number; readonly width: number;
readonly height: number }`. Supply a content-relative rectangle from `getBoundingClientRect()`
after layout, resize, scroll, or app zoom changes. Main converts CSS pixels using the app's zoom
factor and clips bounds to the window content area. Use `'hidden'` before an app overlay covers
the panel or when the panel unmounts; hidden guests are detached. `open()` selects the new tab,
but views remain detached until a visible rectangle is supplied.

`watch()` hydrates the current state asynchronously and replays cached state synchronously when
available. It then delivers whole snapshots: `{ revision, tabs, showing }`. `tabs` is ordered;
each page has `{ tab, address, title, loading, canGoBack, canGoForward, failed }`. `showing` is
`PageOption<Tab>` and `failed` is `PageOption<string>`: clone-safe schema-backed `None`/`Some`
objects with an own `_tag` property. Use `ShowingTab` and `PageLoadFailure` guards/match helpers
exported by the bridge. Full Effect Option instances cannot cross Electron's context bridge,
which drops prototypes. A monotonic `revision` prevents older
hydration responses overwriting newer pushed state. Both watch methods return an unsubscribe
function. Download events carry `{ tab, address, filename }`; the download is already canceled.

Call `await window.vivid.pages.reset()` as part of sign-out: it closes all pages without deleting
browsing data. Window close, whole app-document navigation and server changes also close every
page. `forget()` closes all pages and clears only the `persist:vivid-pages` partition's cookies,
site storage and cache; opening a page while clearing is refused. Neither operation touches the
app's cookies or session.

Typed text uses HTTPS for bare addresses and DuckDuckGo for search text. Localhost, loopback
aliases, credentials, and non-HTTP(S) schemes are refused. Load failures retain Chromium's error
description in `failed` until the next navigation; main supplies no substitute error page.

## Signing in by code

After choosing a server, desktop sign-in uses the server's existing device-authorization flow.
The desktop sign-in UI requests a device code through `/api/auth/device/code`, displays the short
code and opens the returned verification link in the system browser. Sign in to that same server
and approve the code in **Settings → Devices** (`/device`). The desktop UI exchanges the waiting
device code through `/api/auth/device/token`, respecting the server's interval and expiry. No
password is passed through preload. Device sign-in UI and token handling belong to the renderer;
this shell provides server selection in the chooser and native external browsing for navigation.

## Security

The window enables context isolation, sandbox and web security, and disables Node integration
and webviews. There is no remote module. Only the selected origin is proxied with Chromium's
cookie-aware transport. Foreign app-session network requests and cross-origin redirects are
blocked, including WebSocket upgrades. Same-origin redirects remain usable. Foreign navigation
and popup destinations open in the system browser only for HTTP(S); other schemes are refused.
Only the main frame may invoke the schema-decoded bridge. Main checks its document URL for every
request: the bundled chooser alone can choose or forget a server, read settings, or invoke
external browsing. Selected-server documents can read the app version and drive the isolated
Browser through validated page requests. No page guest has preload or bridge access.

Each page uses its own main-owned `WebContentsView` in `persist:vivid-pages`, with sandbox,
context isolation, web security and no Node integration. Only HTTP(S) page and frame navigation
is admitted. Guest permissions, including display capture and device permissions, are denied.
Guest popups open new tabs in the same Browser and downloads are refused with a typed event.

Notifications and sanitized clipboard writes are allowed only for the selected app origin.
Media, clipboard reads and every other permission are denied, including on the chooser.

## Verify

```sh
flock /tmp/vivid-tsc.lock pnpm --filter @vivid/desktop typecheck
pnpm exec oxlint --type-aware apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared
pnpm --filter @vivid/desktop test
```

The optional transport proof stays skipped unless `VIVID_DESKTOP_LIVE_TEST=1`. It requires an
already running isolated desktop app, attached to the installed browser CLI as
`vivid-desktop-lane`, and selected fixture origin `http://127.0.0.1:8797`. The test owns a disposable
HTTP listener on that port and checks cookies, same-origin redirects, streaming and WebSockets.
It never uses an application database.
