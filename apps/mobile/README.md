# Vivid mobile

A separate React Native application for iOS and Android, built with Expo.
Phone screens use native stack navigation; tablets retain a conversation sidebar.
The app uses Vivid web’s design tokens, icons, greeting and product hierarchy.
Its sidebar contains workspace tools, grouped conversation cards, filter/new
controls, Done/Archived and You/Personal. Native pane motion and row interactions
use the T3 implementation. Search, pin, settle, archive, rename and swipe actions
are available. Starter prompts fill
the composer for editing; they do not send automatically.
Actual T3 implementations and adaptations are listed in [T3-SOURCE.md](./T3-SOURCE.md).

## Run

From the repository root:

```sh
pnpm install
pnpm --filter @vivid/agent-runtime dev
# In another terminal: the existing development gateway keeps the runtime token server-side.
pnpm --filter @vivid/web dev --host 0.0.0.0
# In another terminal:
pnpm --filter @vivid/mobile dev
```

Build the native app. The local Kotlin/Swift composer requires a development
build; Expo Go cannot load it:

```sh
pnpm --filter @vivid/mobile android
pnpm --filter @vivid/mobile ios  # macOS + Xcode required
```

These commands generate missing native projects from the pinned SDK 56 template.
They require Android SDK/JDK or Xcode and connect to the selected device.

### Windows Android Studio emulator with WSL

Start the AVD from Windows Android Studio's Device Manager. Run the runtime and
gateway above in WSL, then start Metro for the installed development build:

```sh
pnpm --filter @vivid/mobile exec expo start --dev-client --port 8085 --max-workers 2
```

In another terminal, use the serial reported by `adb devices` (the verified
`Vivid_Android_Studio` instance uses `emulator-5556`):

```sh
adb -s emulator-5556 reverse tcp:8085 tcp:8085
adb -s emulator-5556 reverse tcp:5178 tcp:5178
adb -s emulator-5556 shell am start -n work.vivid.mobile/.MainActivity \
  -a android.intent.action.VIEW \
  -d 'exp+vivid://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8085'
```

For this WSL/Windows setup, save `http://127.0.0.1:5178` as the Server address
in mobile Settings: the reverse mapping forwards that address to the gateway.

Repeat the reverse commands after restarting ADB or the emulator. If the app
remains blank after a disconnected bundle download, force-stop it with
`adb -s emulator-5556 shell am force-stop work.vivid.mobile`, then run the launch
command again. Metro must stay running for this development build.

The Windows emulator avoids the WSLg `WARN:COPY_MODE` display path. This machine's
AVD was verified using host GPU rendering and WHPX acceleration. See
[VALIDATION.md](./VALIDATION.md) for the tested build and remaining checks.

In mobile Settings, set **Server address** to `http://YOUR_COMPUTER_LAN_IP:5178`.
Leave the access token empty when using the web development gateway. `localhost`
on a physical phone refers to the phone. Android defaults to the emulator host
alias `10.0.2.2`; physical phones need the LAN address. The computer and phone must have network
access to each other; WSL users may need host port forwarding.

For a direct runtime connection, enter its reachable base address and runtime
token in Settings. A token selects the `/agents/vivid/:id` route; the gateway uses
`/api/vivid/:id`. Native tokens are saved with Expo SecureStore, never baked into
the application bundle. Browser preview keeps a manually entered token in memory
only. This is the existing local demo authentication model, not production user auth.

Optional: copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_URL` to prefill the
server address. Never put a runtime token in an `EXPO_PUBLIC_*` variable.

The React Native web preview is useful for inspecting the same components:

```sh
pnpm --filter @vivid/mobile web
```

## Feature coverage

| Area          | Mobile behavior                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversations | Grouped list, search, filter, create, rename, pin/unpin, mark done/reopen, archive, restore, delete; durable history, streaming Markdown, tool results, stop, reconnect on foreground.                         |
| Activity      | Work log from the actual transcript; Library citations open authenticated originals.                                                                                                                           |
| Tasks         | Conversation tracking and follow-ups remain. Today is removed from navigation; its task screen implementation is retained but not exposed.                                                                     |
| Routines      | Create/edit, schedule presets/custom cron, timezone, pause/resume/delete, run now, missed runs, run history, retry and opening run conversations. Template ideas share the web fixtures.                       |
| Library       | Native file picker for PDF/text/Markdown, 10 MB limit, indexing/error states, nested folders, rename/move/delete, passage search, original document sharing, ask-about draft.                                  |
| Projects      | Shared sample projects, covers, members, nested projects and conversation titles. Same fixture boundary as web.                                                                                                |
| Connectors    | Contextual Connect cards in conversation; management under Settings. Server status, browser authorization, foreground refresh, Continue after connection, and disconnect. Requires server OAuth configuration. |
| Settings      | Shared light/dark colors, system theme, server connection, secure native token storage.                                                                                                                        |

Pins and settled conversations are device-local. Working status reflects the
active native stream; remote background activity is not exposed by the index API.

Computer control remains a preview. Chat attachments, voice, native push
notifications, production authentication, and project persistence are not added.
Follow-ups and routines still depend on the existing server staying online.
Dates use native OS date/time pickers on iOS and Android; the browser preview
uses a text fallback. Preset routine and repeat choices are tap controls. There is no offline mutation queue.

## Validate

```sh
pnpm --filter @vivid/mobile typecheck
pnpm --filter @vivid/mobile test
pnpm --filter @vivid/mobile exec expo install --check
pnpm --filter @vivid/mobile build
pnpm --filter @vivid/tokens typecheck
```

`build` exports Android/iOS Hermes bundles and the web preview; it is not an APK
or signed iOS archive. An Android build can also be produced with `expo run:android`; an iOS build
requires macOS/Xcode. A successful JavaScript export does not validate native
keyboard, picker, sharing, SecureStore or OS lifecycle behavior.

After editing the shared CSS colors or metrics, run
`pnpm --filter @vivid/tokens generate:native`. Its build/typecheck rejects
stale generated native tokens. See [DESIGN-SOURCES.md](./DESIGN-SOURCES.md) for the source mapping.
