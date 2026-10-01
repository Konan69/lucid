# @vivid/desktop

Electron host for the Vivid web renderer. It owns native window chrome, OS color scheme state,
`vivid://` activation, persisted server selection, and the schema-validated desktop bridge.
Product UI stays in `apps/web`.

## Run locally

```sh
# Terminal 1, from the repository root
pnpm --filter @vivid/web dev

# Terminal 2
pnpm desktop
```

Development loads `VIVID_DESKTOP_RENDERER_URL`, defaulting to `http://127.0.0.1:5178`.

## Build and distribute

Supply the web renderer build first. Serialize its compiler with other lanes:

```sh
flock /tmp/vivid-tsc.lock pnpm --filter @vivid/web build
pnpm --filter @vivid/desktop build
pnpm --filter @vivid/desktop dist --dir
./apps/desktop/release/linux-unpacked/vivid
```

`build` bundles main and sandboxed preload as CommonJS and stages a snapshot of `apps/web/dist`
plus shared design tokens. `dist` packages that snapshot with Electron; `--dir` produces an
unpacked app, while ordinary `dist` produces the host platform's installer. Targets are AppImage
for Linux, dmg for macOS, and nsis for Windows, with app id `com.vivid.app` and `vivid://` activation.
The renderer runs without a web development server. Signing and automatic updates need a release
feed and separate setup; this build has no updater.

The app uses an independently operated Vivid application server. It does not start or package a
server, database, or runtime. The server must expose Better Auth under `/api/auth/*`, product
streams at `/api/live`, the conversation gateway under `/api/vivid/*`, and Library byte routes on
one origin.

## Server selection

`settings.json` in Electron's user data directory stores `{ "version": 1, "serverAddress": "…" }`.
The default is `http://127.0.0.1:8787`. Only HTTP(S) origins are accepted; credentials, paths,
queries, and fragments are rejected. Missing settings mean `Unconfigured`; corrupt or unreadable
settings stop startup. Writes atomically replace the file before publishing new state.

The renderer owner must present the first-launch chooser when `getServerSettings()` returns
`Unconfigured`, then call `setServerAddress(address)`. A successful write navigates the packaged
renderer to that origin. These methods use the existing bridge; this shell does not render a chooser.

Electron serves packaged HTML/assets at the saved server origin and forwards `/api/*` through
Effect HttpClient with Chromium's cookie-aware transport. Relative API URLs, cookies, streaming
responses, and direct WebSocket upgrades retain that origin. The address is never embedded in
the web bundle. Offline API requests fail while the packaged renderer remains available.

## Security boundary

The window uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Preload
exposes only `window.vividDesktop`. Requests, responses, pushed events, persisted window placement,
settings, and deep links are decoded once with Effect Schema at their ingress.

| Renderer method                  | Result                                                      |
| -------------------------------- | ----------------------------------------------------------- |
| `getAppInfo()`                   | Application version, Electron version, and host platform    |
| `getColorSchemeState()`          | Native preference plus resolved light/dark scheme           |
| `onColorSchemeChanged(listener)` | Validated native scheme updates and an unsubscribe function |
| `getServerSettings()`            | First-launch or configured state with a validated origin    |
| `setServerAddress(address)`      | Durable selection; packaged renderer changes origin         |

The bridge exposes no filesystem, shell, credential, cookie, arbitrary IPC, arbitrary remote
navigation, or window-control authority. Its tagged wire contract lives in `src/shared/bridge.ts`.
API document navigation opens outside the privileged shell; local assets reject traversal and
escaping symlinks. `vivid://` activations use the existing `links.ts` parser and focus the single
window. Product route interpretation belongs to the renderer.

## Verify

```sh
pnpm --filter @vivid/desktop test
flock /tmp/vivid-tsc.lock pnpm --filter @vivid/desktop typecheck
pnpm exec oxlint --type-aware apps/desktop/src apps/desktop/scripts/build.mjs
```

The optional live transport test requires the installed `agent-browser` CLI and a separately
launched packaged app with an isolated user data directory. Start that app as a named user unit
with `--remote-debugging-port=9337`, then attach and explicitly select the disposable fixture origin:

```sh
agent-browser --session vivid-desktop-lane connect 9337
agent-browser --session vivid-desktop-lane eval 'window.vividDesktop.setServerAddress("http://127.0.0.1:8797")'
VIVID_DESKTOP_LIVE_TEST=1 pnpm --filter @vivid/desktop test
```

The test binds only its disposable fixture on 8797, owns cleanup, and checks real HTTP bodies,
session cookies, redirects, streaming receipts, and WebSocket upgrades. It never uses a database.
It is skipped by default. Stop only the units you started and close the named browser session.
