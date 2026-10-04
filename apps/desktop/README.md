# @vivid/desktop

Electron shell for the Vivid web app. It connects to a Vivid server the Person chooses; it never
starts a server, database, or runtime. The shell serves its own bundled web build at the chosen
origin and forwards only `/api*` and `/health` to the chosen server. Product UI stays in the web
renderer. Until the shell loads the server's own build, release the shell and server together:
a server-side web-client fix does not update desktop, and mismatched versions may use incompatible
API contracts. The health probe verifies service identity, not version compatibility.

## Build

```sh
pnpm --filter @vivid/web build
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

The address to enter is the one people open Vivid at in a browser, which is the server's
`PUBLIC_URL`. The app serves its interface at that origin and names it as the origin of every
request it forwards, because Chromium adds `Origin` only after the app has taken the request, and
the server accepts sign-in from that one origin. In development that is the web dev server
(port `5178`), which forwards `/api` and `/health`. The chosen origin must match the server's
configured `PUBLIC_URL` for sign-in. The checked-in Alchemy stack currently sets `PUBLIC_URL`
to the server origin on `8787`, rather than the web proxy origin; that setup mismatch needs an
infrastructure decision. A health check alone does not prove sign-in will succeed.

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
containing `getAppVersion()`, `pages` and `device`:

```ts
interface VividDesktopBridge {
  readonly pages: VividPagesBridge
  readonly device: VividDeviceBridge
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
`PagePlacement`, `BrowserState`, `PageFavicon`, `PageDownloadRefused`, and `VividAppBridge` from the bridge export.
The renderer owns the panel, tab row, address input, and sign-out integration.

```ts
type VividAppBridge = Pick<VividDesktopBridge, 'getAppVersion' | 'pages' | 'device'>

interface VividPagesBridge {
  readonly open: (input: PageInput) => Promise<Tab>
  readonly show: (tab: Tab) => Promise<void>
  readonly close: (tab: Tab) => Promise<void>
  readonly move: (input: { readonly tab: Tab; readonly to: number }) => Promise<void>
  readonly duplicate: (tab: Tab) => Promise<Tab>
  readonly reopen: () => Promise<Tab>
  readonly closeOthers: (tab: Tab) => Promise<void>
  readonly go: (input: { readonly tab: Tab; readonly address: string }) => Promise<void>
  readonly back: (tab: Tab) => Promise<void>
  readonly forward: (tab: Tab) => Promise<void>
  readonly reload: (tab: Tab) => Promise<void>
  readonly stop: (tab: Tab) => Promise<void>
  readonly place: (placement: PagePlacement) => Promise<void>
  readonly watch: (listener: (state: BrowserState) => void) => () => void
  readonly watchDownloads: (listener: (event: PageDownloadRefused) => void) => () => void
  /** Close all pages on sign-out without deleting browsing data. */
  readonly reset: () => Promise<void>
  /** Close all pages, then clear cookies, site storage, and cache in the pages partition only. */
  readonly forget: () => Promise<void>
}
```

`Tab` is a branded opaque string minted by main. `PageInput` is `{ readonly address: string }`.
`PagePlacement` is `'hidden'` or `{ readonly x: number; readonly y: number; readonly width: number;
readonly height: number }`. Supply a content-relative rectangle from `getBoundingClientRect()`
after layout, resize, scroll, or app zoom changes. Main converts CSS pixels using the app's zoom
factor and clips bounds to the window content area. Resizes update the same retained view. Menu,
wheel and programmatic app zoom changes re-place the current view; preload reports actual viewport
resize through a private schema-decoded request, without adding renderer authority. Use `'hidden'` before an app overlay covers
the panel or when the panel unmounts; hidden guests are detached. `open()` selects the new tab,
but views remain detached until a visible rectangle is supplied. A selection change, hidden
placement, window hide/minimize, or detachment revokes presentation and native input ownership.
Main tracks a generation, selected owner and scale for each visible lease; resize or zoom never
revives a revoked lease. Send a fresh `place()` after switching selection or dismissing a modal.
Renderer layout/scroll and modal/menu coverage detection remain the renderer's responsibility.

`watch()` hydrates the current state asynchronously and replays cached state synchronously when
available. It then delivers whole snapshots: `{ revision, tabs, showing, using }`. `using` is
`PageOption<Tab>`: the page Vivid is acting on for the length of one action (see "Vivid using
this computer"); the renderer says so on that page. `tabs` is ordered;
each page has `{ tab, address, title, favicon, loading, canGoBack, canGoForward, failed }`. `showing` is
`PageOption<Tab>`; `failed` and `favicon` are `PageOption<string>`: clone-safe schema-backed `None`/`Some`
objects with an own `_tag` property. Use `ShowingTab` and `PageLoadFailure` guards/match helpers
and `PageFavicon` guards/match helpers exported by the bridge. Full Effect Option instances cannot cross Electron's context bridge,
which drops prototypes. A monotonic `revision` prevents older
hydration responses overwriting newer pushed state. Both watch methods return an unsubscribe
function. `move({ tab, to })` uses a final zero-based index, preserves selection, and rejects an
out-of-range index with `PagePositionInvalid`. `duplicate(tab)` opens the current address in a
fresh context immediately after its source and selects it. `reopen()` selects the last closed
address with a fresh handle at its old slot, clamped to the current order; history is limited to
ten descriptors and consumed only after successful admission. It rejects `PageReopenEmpty` when
empty. Neither operation restores Chromium history, form state or a live browsing context.
`closeOthers(tab)` selects the survivor and closes other pages in visual order. All new-context
operations retain the 12-page `PageLimitReached` refusal. Opener relations and reopen descriptors
stay internal. Reset/forget discard reopen history.

Guest `window.open` and target-blank HTTP(S) links open immediately after their opener. Chromium's
background-tab intent (including middle/modified link clicks) preserves the current selection.
Foreground intent selects the new page. Native popups are denied: the shell recreates only the
URL in its own sandboxed view. It does not preserve JavaScript `window.opener`, POST bodies,
named-window reuse or the original popup context; target-blank POST requests are refused.

Download events carry `{ tab, address, filename }`; the download is already canceled. Real download capability, permissions, progress, save/open and
durable lifecycle handling are out of scope; downloads remain refused.

Call `await window.vivid.pages.reset()` as part of sign-out: it closes all pages without deleting
browsing data. Window close, whole app-document navigation and server changes also close every
page. `forget()` closes all pages and clears only the `persist:vivid-pages` partition's cookies,
site storage and cache; opening a page while clearing is refused. Neither operation touches the
app's cookies or session.

Typed text uses HTTPS for bare addresses and DuckDuckGo for search text. Localhost, loopback
aliases, credentials, and non-HTTP(S) schemes are refused. Load failures retain Chromium's error
description in `failed` until the next navigation; main supplies no substitute error page.

## Signing in

After choosing a server, the bundled web renderer uses the same email/password sign-in and
account creation as the browser. Chromium's cookie-aware application session carries Better
Auth's HttpOnly session cookie through the selected-origin proxy. Main and preload do not
handle passwords or store a separate bearer token.

The server supports device authorization and the web Settings → Devices page approves codes,
but the desktop renderer does not currently request or exchange its own device code. That is
implemented by mobile. Adding a desktop code flow would require renderer work.

## Vivid using this computer

Stage 1: the browser only. Once a Person is signed in, the app enrols this installation as one
of their computers (`EnrolDevice`, with the machine's host name), and waits. Enrolling grants
nothing. When the Person allows it (Settings → Devices → Your computers, on any surface), the app
holds `WatchDeviceRequests` open on the live socket and carries out each `BrowserAction` Vivid
sends, in the app's own Browser, answering on the same connection. Revoking, signing out or
choosing another server ends the link.

- **Identity** (`main/installation.ts`): a random `InstallationId` in `installation.json` under
  Electron's user data directory, made once. It never leaves the main process; the renderer is
  told only the `DeviceId` it enrolled as (`window.vivid.device.get()`).
- **The link** (`main/device.ts`): the main process opens its own socket to `/api/live` with
  Electron's `net.WebSocket` in the app session (`persist:vivid`), which sends that session's
  cookies on the upgrade; the main process never reads the cookie, and never uses
  `persist:vivid-pages`. (Electron 44.4.3 does not export `WebSocket` from `electron` itself,
  whatever its type declarations say.) While waiting to be allowed, or when the server cannot be
  reached, it tries again after 1 s, doubling to at most 30 s. Signed out or revoked, it rests
  until the session changes, the server changes, or the renderer calls
  `window.vivid.device.refresh()`. Nothing is replayed.
- **Consent ends action.** An action runs inside the listening: when the server ends the link
  (revoke, sign-out, a newer link), when the connection fails, or when the session token cookie
  changes, the action in progress is interrupted at once, held keys and the mouse button are
  released, and nothing further is sent.
- **The executor** (`main/control.ts`, `main/driver.ts`): one action at a time, through
  Chromium's debugger on the page (`webContents.debugger`), ported from the reference desktop's
  control session. A control is named by its accessible name, exactly one match or the step
  fails. An action past its `expiresAt` is not started, and input is never sent twice. The
  debugger session must be Vivid's own: a page with developer tools open, or with another
  debugger attached, is not acted on.
- **Stop**: while an action runs on a page, the renderer shows "Vivid is using this page." and a
  Stop button (`window.vivid.pages.stopVivid(tab)`). Stop ends that action at once and it is
  answered `Refused: Stopped`. The Person using the page does not stop Vivid: the reference's
  human-control epochs and expected-input matching are deliberately not ported (owner's
  decision, 4 October 2026). Pages have no bridge, so a website cannot press Stop.
- **Where Vivid may go** (`main/reach.ts`): a navigation Vivid starts is allowed only to the
  public internet. Loopback, private, link-local, carrier-grade NAT and IPv6 unique-local and
  link-local addresses are refused, for the first address (resolved first; every resolved
  address must be public) and for every redirect of that load. The Person's own typing in the
  address bar is unchanged. Not closed: Chromium resolves the name again when it connects, so a
  name that answers public here and private a moment later (DNS rebinding) gets through; and
  only main-frame requests are checked, not frames inside a page.
- **Passwords**: what an `input type=password` in the main document holds is never in an
  answer; the outline says "(hidden)". Fields inside frames or shadow roots are not found by
  that query and rely on Chromium's own masking.

| Action ends as                                                                                                               | Answer                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Carried out                                                                                                                  | `Done` with the page in front: address, title, outline, tabs |
| The Person pressed Stop                                                                                                      | `Refused: Stopped`                                           |
| No page is open, or the page closed                                                                                          | `Refused: PageGone`                                          |
| A local or private address (first hop, resolved name or redirect), a non-web address, or words that are not an address       | `Refused: NotAllowed`                                        |
| A key outside the ones Vivid may press                                                                                       | `Refused: Unsupported`                                       |
| The control was not found or is ambiguous, the page refused the text, a debugger command failed, the debugger is not Vivid's | `Failed`                                                     |
| Its deadline passed before or during the action, or the link ended                                                           | no answer; the server has already closed it                  |

`Screenshot` answers with the picture (`BrowseResult.picture`, a base64 PNG at most 1280 pixels
wide); no other action carries one. Closing the last page answers `Done` with an empty address
and title and no tabs, because the contract has no "no page" form.

What running it against real pages changed (each is stated beside its code):

- A page has a size (1280 by 800) and is on the window, hidden, from the moment it opens.
  Without a size nothing in it can be clicked or captured; without the window Chromium delivers
  no pointer input.
- A click turns focus emulation on, waits for the page to confirm it, and checks that the page
  saw the button go down. A page that is not drawn takes clicks this way.
- A key is pressed only on a page drawn on the window. Keys to an undrawn page arrived, were
  dropped, or arrived after the answer; none of that can be reported honestly. The renderer
  brings the page Vivid is using forward, the executor waits up to 3 s for it, and otherwise
  the step fails with nothing sent. No `Page.bringToFront`: the key after it was dropped.
- A press the page never saw is `Failed`, after half a second's grace, never a second press.
- After any action the executor waits for a navigation the page asked for
  (`Page.frameRequestedNavigation`) until the page is neither leaving nor loading.
- A hop stopped by the rule every page obeys (no loopback) is reported to Vivid as
  `NotAllowed`, not answered as the old page.

### The proof

`scripts/control.ts` runs the real executor inside real Electron against real pages, under
`xvfb-run`, in a disposable profile; `src/main/driver.live.test.ts` runs it when asked (it needs the public internet, so the push gate skips it):

```sh
VIVID_TEST_DESKTOP_LIVE=1 pnpm --filter @vivid/desktop exec vitest run src/main/driver.live.test.ts
```

It needs the public internet (`https://example.com`, and `https://httpbin.org/redirect-to` for a
public address that redirects to this computer). It proves: Open, Read, Click by name with a
real navigation, Back, Type with read-back, Press, a hidden password value, Screenshot of a
page that is not drawn and of one that is, Stop (including in the middle of a click, with
nothing left held), the refusals (loopback, private, and public redirects to each), and that
`net.WebSocket` in a session sends that session's cookie.

Not proved:

- The link against a real server. It needs a signed-in session; only its transport is proved.
- The refusal of a page with developer tools open. The pages session admits only web addresses,
  so developer tools never open on a page and the case cannot be reached.
- That the renderer brings the page forward when Vivid starts using it, and the Stop button:
  the proof has no renderer.
- DNS rebinding is not closed (see "Where Vivid may go").

## Security

The window enables context isolation, sandbox and web security, and disables Node integration
and webviews. There is no remote module. Only the selected origin is proxied with Chromium's
cookie-aware transport. Foreign app-session network requests and cross-origin redirects are
blocked, including WebSocket upgrades. Same-origin redirects remain usable. Foreign navigation
and popup destinations open in the system browser only for HTTP(S); other schemes are refused.
Only the main frame may invoke the schema-decoded bridge. Main checks its document URL for every
request: the bundled chooser alone can choose or forget a server, read settings, or invoke
external browsing. Selected-server documents can read the app version, drive the isolated
Browser through validated page requests, and read or refresh this computer's link. No page guest has preload or bridge access.

Each page uses its own main-owned `WebContentsView` in `persist:vivid-pages`, with sandbox,
context isolation, web security and no Node integration. Only HTTP(S) page and frame navigation
is admitted. Guest permissions, including display capture and device permissions, are denied.
Guest popups open new tabs in the same Browser and downloads are refused with a typed event.

Notifications and sanitized clipboard writes are allowed only for the selected app origin.
Media, clipboard reads and every other permission are denied, including on the chooser.

## Verify

### Existing desktop checks

```sh
pnpm --filter @vivid/desktop typecheck
pnpm exec oxlint --type-aware apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared
pnpm --filter @vivid/desktop test
```

The optional transport proof stays skipped unless `VIVID_DESKTOP_LIVE_TEST=1`. It requires an
already running isolated desktop app, attached to the installed browser CLI as
`vivid-desktop-lane`, and selected fixture origin `http://127.0.0.1:8797`. The test owns a disposable
HTTP listener on that port and checks cookies, same-origin redirects, streaming and WebSockets.
It never uses an application database.
