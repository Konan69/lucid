# @vivid/desktop

Electron shell for the Vivid web app. It connects to a Vivid server the Person chooses; it never
starts a server, database, or runtime. Product UI stays in the web renderer.

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

Import `VividDesktopBridge`, `ServerSettings` and `ServerChoice` from `@vivid/desktop/bridge`
(`src/shared/bridge.ts`). The only exposed global is `window.vivid`:

```ts
interface VividDesktopBridge {
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
No IPC channel, filesystem, credential, cookie or arbitrary navigation authority is exposed.

## Signing in by code

After choosing a server, desktop sign-in uses the server's existing device-authorization flow.
The desktop sign-in UI requests a device code through `/api/auth/device/code`, displays the short
code and opens the returned verification link in the system browser. Sign in to that same server
and approve the code in **Settings → Devices** (`/device`). The desktop UI exchanges the waiting
device code through `/api/auth/device/token`, respecting the server's interval and expiry. No
password is passed through preload. Device sign-in UI and token handling belong to the renderer;
this shell provides server selection and HTTP(S) external browsing.

## Security

The window enables context isolation, sandbox and web security, and disables Node integration
and webviews. There is no remote module. Only the selected origin is proxied with Chromium's
cookie-aware transport. Foreign app-session network requests and cross-origin redirects are
blocked, including WebSocket upgrades. Same-origin redirects remain usable. Foreign navigation
and popup destinations open in the system browser only for HTTP(S); other schemes are refused.
Only the trusted main frame may invoke the schema-decoded bridge.

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
