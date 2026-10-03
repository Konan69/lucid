# Vivid mobile

A separate React Native application for iOS and Android, built with Expo `57.0.24` and React
Native `0.86.3`. Native stack screens use the same contracts, RPC client, and product state as
web and desktop. Current routes are declared in `src/workspace.ts`; historical source mappings
remain in [T3-SOURCE.md](./T3-SOURCE.md).

## Run

Start the local application stack from the repository root, with the credentials described in
the root README supplied in the environment:

```sh
pnpm install
pnpm infra:dev
```

In another terminal:

```sh
pnpm --filter @vivid/mobile dev
```

The local Kotlin/Swift composer needs a development build; Expo Go cannot load it:

```sh
pnpm --filter @vivid/mobile android
pnpm --filter @vivid/mobile ios  # macOS + Xcode required
```

`android` and `ios` generate missing native projects using the SDK 57 bare template selected in
`apps/mobile/scripts/native.mjs`, then run Expo's native build. They require Android SDK/JDK or Xcode.
No physical-device validation is claimed; [current status](../../docs/14-product-feature-set-and-grok-bot-parity.md)
records mobile as tested in suites, not run on a device. Older validation notes describe their
own dated builds.

### Server and sign-in

On first launch, enter the reachable application origin, for example
`http://YOUR_COMPUTER_LAN_IP:5178` for a locally exposed Vite proxy. A physical phone's
`localhost` is the phone; an Android emulator can reach its host using `10.0.2.2`. Neither
address is selected automatically. The Alchemy stack binds services to loopback; LAN/WSL use
requires a separately exposed proxy or port forwarding.

Sign in with email/password, create an account, or pair with a code approved by a signed-in
browser at `/device`. Native session tokens are saved in Expo SecureStore and sent as bearer
authority on HTTP requests and the live WebSocket. Browser preview keeps tokens in memory and
persists only the server address, so reloading signs it out. This is a Person's session token;
the runtime token stays on the application server.

Every conversation uses `/api/vivid/:threadId`; live queries and writes use `/api/live`.
There is no direct-runtime connection mode. `EXPO_PUBLIC_API_URL` remains in the old example
environment file but is not read by current code.

### Over-the-air updates

An installed build asks its Vivid for newer JavaScript at launch and after a long absence, and
restarts into what it downloaded the next time the app is backgrounded (`src/data/update.ts`).
The server speaks the Expo Updates protocol itself (`apps/server/src/updates`); no Expo service
or account is involved.

- The build must be given its server: `VIVID_SERVER=https://your-vivid pnpm exec expo prebuild`
  (or any build that evaluates `app.config.ts`). That sets both the app's address and its update
  address. A build with no `VIVID_SERVER` has updates off. Development builds load from Metro and
  never ask.
- The hosted server image exports the update itself, so deploying the server publishes the app.
  For a server run by hand, export one and point the server at it:

  ```sh
  pnpm --filter @vivid/mobile run updates /path/to/updates
  VIVID_MOBILE_UPDATES=/path/to/updates  # in the server's environment, then restart it
  ```

- An update only reaches a binary with the same runtime version, which is `version` in
  `app.json`. JavaScript and assets travel over the air; anything native does not. After adding
  a native module, changing a config plugin or moving to a new Expo SDK, raise `version` and
  install a new binary. An update is only taken when it is newer than the JavaScript built into
  the binary.

### Windows Android Studio emulator with WSL

Start an AVD in Windows Android Studio. With the application stack running, start Metro:

```sh
pnpm --filter @vivid/mobile exec expo start --dev-client --port 8085 --max-workers 2
```

Use the serial from `adb devices` in these commands (`emulator-5556` is an example):

```sh
adb -s emulator-5556 reverse tcp:8085 tcp:8085
adb -s emulator-5556 reverse tcp:5178 tcp:5178
adb -s emulator-5556 shell am start -n work.vivid.mobile/.MainActivity \
  -a android.intent.action.VIEW \
  -d 'exp+vivid://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8085'
```

Enter `http://127.0.0.1:5178` as the app's server address. Repeat the reverse mappings after
restarting ADB or the emulator; Metro must stay running for the development build. These are
setup instructions, not proof that the current native app has been validated.

## Feature coverage

This table describes code present today, not native end-to-end proof.

| Area                    | Implemented surface                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Threads                 | Create, rename, archive/restore, delete, title search, attention lanes, durable history, streaming, stop, foreground reconnection, saved drafts. |
| Shared work             | Personal and Company spaces, Memberships, shared/private Threads, attributed deliveries, People and invitations.                                 |
| Questions and Approvals | Thread cards use shared server contracts for answers and decisions.                                                                              |
| Routines                | Live definitions and Occurrences, creation/editing, pause/resume, delete, run now and run history.                                               |
| Library                 | File picker for PDF/text/Markdown, 10 MiB limit, folders, indexing status, search, authenticated original sharing.                               |
| Projects                | Persisted recursive Projects and their Threads, read through the same live RPCs as web.                                                          |
| Integrations            | Thread request cards and Settings management; Executor handles sign-in or key entry. Code calls these `Connection`.                              |
| Skills and memory       | Skills list and memory Settings read shared server records; memory requires HelixDB configuration.                                               |
| Computer                | Server-backed state and viewer screen; Boat provider proof does not establish mobile viewer or input behavior.                                   |
| Settings                | System/light/dark theme, server selection, session handling, Company People and memory.                                                          |

There is no offline mutation queue. Voice and native push notifications are not built. Mobile
chat's composer has no picture-send path yet; Library upload is separate. Browser/desktop
conversations and server-owned background work are shared rather than replaced by phone-local
execution.

## Validate

Run checks serially:

```sh
pnpm --filter @vivid/mobile test
pnpm --filter @vivid/mobile exec expo install --check
pnpm --filter @vivid/mobile build
pnpm --filter @vivid/tokens typecheck
```

`build` exports Android/iOS Hermes bundles and the web preview; it is not an APK or signed iOS
archive. For code changes, the final repository gate runs serialized typecheck. JavaScript
export alone does not validate native keyboard, sharing, SecureStore, or lifecycle behavior.

The React Native web preview is available with `pnpm --filter @vivid/mobile web`.
The token package's build/typecheck rejects stale generated native tokens; design changes and
`generate:native` belong to the UI owner. See [DESIGN-SOURCES.md](./DESIGN-SOURCES.md).
