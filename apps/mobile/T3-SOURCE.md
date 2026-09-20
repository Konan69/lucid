# Source and asset provenance

Vivid's visual reference is `apps/web`, including `src/ui/Face.tsx`,
`src/screen/Conversation.tsx`, `src/data/projects.ts`, and the shared CSS tokens.
The mobile app uses native views; no WebView wraps the web app.

## T3 implementation

The original layout utilities came from `/home/kixey/t3code-c9`, commit
`6777fc58bc0430875eb399e131539a2d17202666`. Composer and swipe implementation
came from `/home/kixey/t3code`, commit
`2f4dcc07439c3b2ce8374076cbd88bd6c6c42933`.
The MIT notice is retained in [T3-LICENSE](./T3-LICENSE), and in the native module.

| T3 source                                               | Vivid adaptation                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/t3-composer-editor`                            | Kotlin Android editor, Swift UIKit editor, Expo module registration and build files copied into `modules/t3-composer-editor`.                                                                                                                                                                                                                                                         |
| `src/native/T3ComposerEditor.native.tsx`                | Native bridge with revision acknowledgement, selection synchronization, native echoes and pending-event pruning. Vivid theme/font adapters replace T3 dependencies; RGB tokens are converted to the hex format expected by each native parser; file/skill chips and image paste are not exposed by Vivid's text API. Both platforms use this adapter to their respective native view. |
| `src/native/composerEditorRevision.ts`                  | Revision logic retained, with regression tests for stale keystrokes, selection mismatch and intentional clearing.                                                                                                                                                                                                                                                                     |
| `src/native/T3ComposerEditor.tsx`                       | TextInput fallback for the web preview. Native platforms resolve the Kotlin/Swift view.                                                                                                                                                                                                                                                                                               |
| `src/features/home/thread-swipe-actions.tsx`            | Swipe spring, full-swipe thresholds, haptics, reset logic and scroll gating retained; Vivid colors and Lucide icon adapter replace T3 styling.                                                                                                                                                                                                                                        |
| `patches/react-native-gesture-handler@2.31.2.patch`     | Retained through pnpm patchedDependencies: rejects vertically dominant initial pans before a row swipe activates.                                                                                                                                                                                                                                                                     |
| `src/ui/ControlPillMenu.tsx`                    | Native menu wrapper and long-press release suppression adapted for Vivid's theme. Android uses a separate native menu anchor, opened by the row's cancellable long press, so the menu cannot intercept T3's swipe gesture.                                                                                                                                                            |
| `src/ui/ControlPill.tsx`                        | 44-point touch targets and press-in/release deduplication adapted; shape and visual treatment use Vivid web tokens in `src/ui/ui.tsx`.                                                                                                                                                                                                                                        |
| `src/ui/AndroidScreenHeader.tsx`                | Safe-area, embedded header and action layout adapted in `ui.tsx`. Workspace screens use native-stack navigation bars on iOS; chat uses the shared custom header.                                                                                                                                                                                                                      |
| `src/data/{layout,adaptive-navigation,layoutMetrics}.ts` | Layout and navigation calculations copied and used in the phone/tablet shell. Typography now consumes Vivid web metrics.                                                                                                                                                                                                                                                              |
| `src/features/layout/workspace-pane-animation.ts`       | Copied unchanged and used for the animated native sidebar.                                                                                                                                                                                                                                                                                                                            |

The product screens and Flue connection are Vivid code. T3's coding providers,
terminal, authentication and coding state subsystem are not included.
The welcome screen, sidebar hierarchy and composer chrome adapt Vivid web.
T3's actual pane timing and composer transition durations drive native movement.
See [DESIGN-SOURCES.md](./DESIGN-SOURCES.md) for the component-by-component mapping.

The Android menu dependency is patched to pass an empty command argument array
instead of `undefined`. RN 0.85's Fabric command bridge rejects the latter as
“expected Array, got a null” when opening a long-press menu.

## Vivid assets

- `src/ui/Face.tsx` ports the circular disc, two tilted dark eyes, mood
  geometry and radial highlight from `apps/web/src/ui/Face.tsx`. It replaces the
  earlier square smiling face. It does not reproduce CSS inset shadows exactly.
- `assets/icon.png` is a launcher export of the existing web Face, rendered
  from the retained `assets/icon.html` source at 1024 × 1024.
- `src/ui/Mark.tsx` ports the existing web service SVG paths to
  React Native SVG without substituting generated service imagery.
- The six project covers are direct `require` references to
  `apps/web/public/covers/*.png`; no generated replacements or remote imagery.
- Projects and routine ideas import the existing web fixtures. Projects remain
  explicitly labeled sample content, matching the web persistence boundary.
- All native semantic colors are generated from
  `packages/design/tokens/src/tokens.css`. `face-eye` records the existing web
  face's `#0f0f0f` eye color in that shared source.

## Reconstructed Grok Bot inspection

The actual renderer's semantic Sand table was extracted as an audit reference,
including primitive palettes and source hash. Vivid web remains the active design
source; see [DESIGN-SOURCES.md](./DESIGN-SOURCES.md) and
[design-reference/grok-sand.ts](./design-reference/grok-sand.ts).

## Where each file lives in Vivid

The left column above is T3's own path. Vivid keeps the code under one-word filenames, with the
directory carrying the context:

| T3 path                                           | Vivid path                                    |
| ------------------------------------------------- | --------------------------------------------- |
| `src/native/T3ComposerEditor*.tsx`, `.types.ts`   | `src/native/composer/Editor*.tsx`, `types.ts` |
| `src/native/composerEditorRevision.ts`            | `src/native/composer/revision.ts`             |
| `src/features/home/thread-swipe-actions.tsx`      | `src/t3/swipe.tsx`                            |
| `src/ui/ControlPillMenu.tsx`              | `src/t3/Menu.tsx`                             |
| `src/features/layout/workspace-pane-animation.ts` | `src/t3/pane.ts`                              |
| `src/data/adaptive-navigation.ts`                  | `src/data/navigation.ts`                       |
| `src/data/layoutMetrics.ts`                        | `src/data/metrics.ts`                          |
