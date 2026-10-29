# Desktop app

Model requirement: real. Browser control asks the shipped model to use `browse` on the Person's computer. Rehearsal cannot prove this path.

## Sub-features

The built Electron app chooses the disposable server, opens Google in a separate system browser, cancels that attempt, and signs in with the run's existing email identity. Its installation appears Pending. Allow brings its native device stream online. A message asks Vivid to open and read Example Domain in the app's Browser. Revoke ends the stream.

The egress socket is separate from the device stream. A successful WebSocket upgrade does not prove routing through a Person Computer. The disposable server has no such Computer or Boat authority.

## How to get to it (user POV)

Open a new desktop installation. Enter the server address and choose Connect. Choose Continue with Google, then Cancel in Vivid. Choose I already have an account and sign in. Open Feed and Allow this computer. Open a Thread and ask Vivid to open Example Domain on your computer.

## Driving it with verify-vivid

Run on the selected devbox after normal Launch and Doctor. Additional prerequisites: Xvfb, xdg-open, the pinned Electron binary and its Linux libraries, and Chrome. If dependency installation restored Electron without its binary, run `node apps/desktop/node_modules/electron/install.js`. No physical display is used. Select a usable shipped model explicitly at Launch when the default provider cannot authenticate; for example, `VIVID_VERIFY_MODEL=openrouter/z-ai/glm-5.3-flash`. A provider rejection remains blocked, never verified.

```sh
.agents/skills/verify-vivid/verify desktop pi-<id>
.agents/skills/verify-vivid/verify cleanup pi-<id>
```

Use a new Launch for each repetition. The command runs the shipped desktop bundler with scratch outputs and the web assets Launch built. Only output locations and module resolution change. The Windows Computer release download is omitted: Linux cannot execute those binaries. It starts Xvfb with an allocated display, the actual app entry, and private app/default-browser profiles. The OS opener is xdg-open with a run-owned Chrome default. CDP drives mouse/text input and reads DOM and the public pages subscription. Main, the Device, browser executor and auth session are real.

Read `desktop/context.json`, `desktop/verdict.json`, screenshots and DOM text together. `signin-handoff.json` records the shell-generated path, loopback port, rejected stray return and server redirect to Google. `signin-cleanup.json` proves Cancel closed the listener. Pending/Connected/Offline receipts prove the actual installation's link. Thread settlement, history, before/after screenshots and `native-pages.json` prove the guest page. Raw NetLog stays in private scratch; only sanitized egress event/source metadata and the HTTP 101 upgrade receipt survive in `egress-socket.json`.

The command closes native processes in finally. Normal cleanup and abandoned-run recovery retry retained desktop process receipts. `desktop/cleanup.json` survives. Skill cleanup removes profiles, private opener URLs and raw NetLog; confirm evidence still exists afterward.

## Gotchas

- A supported verdict covers the Linux development app only. An unavailable model records blocked and fails the command; other action or cleanup failures record failed. A screenshot alone cannot prove a server decision or model action.
- Google grant/session trade: blocked. Launch supplies a synthetic Google client. Even an existing web session leaves for Google through the desktop start endpoint. The recipe proves outbound handoff and Cancel; it signs in separately through the real email form.
- Egress routing: blocked without a disposable running Person Computer and Boat/SSH authority. GetEgress Waiting and a socket upgrade are separate from device Connected. Neither proves Routing, tunneled bytes or public exit IP.
- Windows app control, native notices, protocol activation, cookie import/encryption and foreground behavior require an isolated Windows installation. Linux does not advertise Windows apps. macOS Keychain, native focus/menus and installation require macOS. Installers, updates and packaged resources require packaged binaries on the target OS. Those claims stay blocked.
- Example Domain must be reachable from the devbox. Keep every process on Xvfb and every profile in scratch. Never use the owner's display, installed profile, production account or real Computer identity.
