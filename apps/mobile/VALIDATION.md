# Native validation — 2026-09-05

## Vivid web design-system revision

The native app now adapts Vivid web's sidebar hierarchy, conversation cards,
shared grouping function, compact controls, Face, greeting and composer. CSS
colors and geometry/type/duration metrics share a generated native export.
T3's actual pane timing is used by Reanimated; native editor and row interactions
remain the T3 implementations/adaptations.

Verified on the Windows Android Studio AVD `Vivid_Android_Studio`, serial
`emulator-5556`, with the installed native development APK:

- Welcome, sidebar and thread render using Vivid's tokens and actual Face.
- A clean emulator/app restart retains saved conversation grouping. Android
  Back closes the sidebar and returns to the welcome view.
- Pin moves the selected conversation to Pinned. Filtering Pinned and opening
  that conversation work with real index data.
- Mark done moves the conversation into the collapsible Done section; Reopen
  returns it to Pinned while retaining history.
- Long-press opens the Android native action menu. A dependency patch fixes its
  null command argument error on RN 0.85 Fabric.
- The native editor stays above the Android keyboard. The color adapter now
  sends hex values accepted by the native parsers; entered text is legible in
  dark mode rather than falling back to black.
- Sending “Reply with just verified.” in an existing validation conversation
  received the real “verified.” response. The composer cleared and the index
  preview updated.
- Mobile and web TypeScript checks, oxlint, token staleness check and 18 tests
  pass. New tests cover shared group priority and native color conversion.

The revised JavaScript uses the existing APK; no native source rebuild was
required. Screenshots are local ADB captures under `/tmp/vivid-web-system-*`.
`DESIGN-SOURCES.md` records the exact web/T3/Grok source mapping and the limits
of live activity and device-local pin/settled state.

## Build and source checks

- Android x86_64 debug development APK built successfully with Gradle, including
  the T3 Kotlin composer and React Native native dependencies.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`; package
  `work.vivid.mobile`. Native build output is ignored by Git.
- Mobile TypeScript check, oxlint and all 18 unit tests passed after the latest
  JavaScript fixes.
- Android/iOS Hermes and web exports passed during implementation. iOS native
  compilation and device behavior have not been tested; they require macOS.
- T3 native module source was compared with the referenced checkout; provenance
  and adaptation details are in [T3-SOURCE.md](./T3-SOURCE.md).

## Observed on Android

- Native home and conversation screens render with the real Vivid assets.
- T3 composer accepts text, selection, replacement and clearing. Android keyboard
  show/hide keeps the composer visible without leaving a blank gap.
- A real message, “Reply with just ready.”, received “Ready”; history persisted
  and the composer cleared.
- Conversation archive, swipe actions and restore were checked against the API.
- The task form and Android date picker opened.
- The Windows Android Studio AVD `Vivid_Android_Studio`, serial `emulator-5556`,
  boots and displays the installed app. A Windows desktop capture confirmed the
  app inside the emulator window, in addition to ADB screenshots.

The earlier WSLg emulator was closed. The Windows emulator uses host GPU rendering
and WHPX. Restoring ADB reverse mappings and relaunching the development app fixed
an interrupted Metro bundle connection. Captures of the desktop must bring the
emulator in front: a covered window can produce a misleading blank capture.

## Scope of evidence

Task mutations and Library upload/search/delete passed supplemental API/browser
checks. Full native task save/completion, document picker/upload/sharing,
SecureStore persistence, connector authorization and Android
lifecycle coverage remain to be verified end to end. Opening a native form is
not evidence that every action inside it works.

Validation used an isolated runtime database under `/tmp/vivid-native-validation`.
The APK is a development build requiring Metro, not a signed production release
or an ARM64 device build. Feature boundaries are listed in [README.md](./README.md).

## Navigation and connector follow-up

- Web and native navigation no longer expose Today or Connectors; native Settings
  opens the live connector management screen, verified via ADB.
- A real web request, “Find the latest email from Dami about the NDA.”, produced
  a persisted `suggest_connector` tool result and an inline Gmail Connect card.
- All 18 mobile tests and 6 runtime tests passed. The added contract tests reject
  unsupported connector IDs, malformed reasons, and unsafe authorization URLs.
- Web/native/runtime typechecks, token staleness check, oxlint and the production web build passed after the final changes.
- OAuth account authorization and the connected-state Continue flow have not been
  completed with a real account. No credentials were added during validation.
