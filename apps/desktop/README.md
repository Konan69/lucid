# @vivid/desktop

Electron host for the Vivid web renderer. It owns native window chrome, OS color scheme state,
`vivid://` activation, and the schema-validated desktop bridge. Product UI stays in `apps/web`.

## Run locally

```sh
# Terminal 1, from the repository root
pnpm --filter @vivid/web dev

# Terminal 2
pnpm desktop
```

Development loads the renderer from `VIVID_DESKTOP_RENDERER_URL`, defaulting to
`http://127.0.0.1:5178`. A packaged app loads `<resources>/web/dist/index.html`; build the web app
before running `pnpm --filter @vivid/desktop package`.

## Security boundary

The window uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Preload
exposes only `window.vividDesktop`. Requests, responses, pushed events, persisted window placement,
and deep links are decoded once with Effect Schema at their ingress.

| Renderer method                  | Result                                                      |
| -------------------------------- | ----------------------------------------------------------- |
| `getAppInfo()`                   | Application version, Electron version, and host platform    |
| `getColorSchemeState()`          | Native preference plus resolved light/dark scheme           |
| `onColorSchemeChanged(listener)` | Validated native scheme updates and an unsubscribe function |

The bridge exposes no filesystem, shell, credential, cookie, arbitrary IPC, remote navigation, or
window-control authority. Its tagged wire contract lives in `src/shared/bridge.ts`.

## Layout

- `src/shared/bridge.ts` — isomorphic tagged IPC contract
- `src/main/` — Electron lifecycle, native window, theme, links, and placement
- `src/preload/main.ts` — isolated renderer bridge
- `electron-builder.yml` — Linux, macOS, and Windows packaging config
