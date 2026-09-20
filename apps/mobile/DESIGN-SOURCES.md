# Vivid native design sources

The product source is Vivid web. The mobile app adapts its existing design system
and product structure to native views and touch targets.

| Source                                                           | Native implementation                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/design/tokens/src/tokens.css`                          | Generated `nativeTokens` for both themes and `nativeMetrics` for type, radii, control/row geometry and duration. The CSS phone radius factor is retained. Native actions have at least 44-point touch targets.        |
| `apps/web/src/screen/Sidebar.tsx`                                | Navigation strip, Vivid identity, Routines/Projects/Library, Conversations controls, Face/time/title/preview cards, Done/Archived sections, You/Personal footer.                                                      |
| `apps/web/src/data/lanes.ts`                                     | Shared executable grouping function extracted from the web sidebar. Pinned takes priority, then Needs you, Working, and date groups. Native uses live data rather than the web's demonstration working conversations. |
| `apps/web/src/screen/Empty.tsx` and `data/fixtures.ts`           | Original greeting, question and suggested prompts. Suggestions import the existing array and fill the native editor.                                                                                                  |
| `apps/web/src/screen/Conversation.tsx`                           | Compact left-aligned header, work-log/screen actions, surface-3 composer, Message Vivid placeholder, attachment/tool entry, send/stop.                                                                                |
| `apps/web/src/ui/Face.tsx`                                       | Actual disc, eye geometry, highlight and whole-face mood rotation, rendered with native SVG. Mood changes animate with Vivid's base duration.                                                                         |
| `apps/web/src/ui/Button.tsx` and `Empty.tsx`                     | Compact control radii, ghost and filled treatments, press feedback. `MotionPressable` runs Vivid's .98 press scale on the UI thread.                                                                                  |
| `apps/web/src/ui/Marks.tsx`, `data/projects.ts`, `public/covers` | Existing service SVGs, project data and cover assets, retained without replacement imagery.                                                                                                                           |

Pins and settled conversations currently persist on the device in the existing
preferences store. The backend does not expose those fields. Needs you uses unread notifications linked
to a conversation. Working reflects the active native agent stream. Other clients'
background streams are not available through the conversation-index API.

## T3 implementation

The native composer, revision handling, swipe actions, haptics and native menus
remain the T3 implementations/adaptations listed in `T3-SOURCE.md`.
The theme bridge converts Vivid RGB colors to Android ARGB / iOS RGBA hex; the
Android menu patch supplies the command argument array required by Fabric.
`src/t3/pane.ts` is copied from T3's actual layout feature:
260 ms, cubic in/out, system reduced-motion handling. The pane fades in over its
first 80 points; the thread keeps its width during the phone drawer animation.
The sidebar control and scrim toggle the same pane animation. Android keeps its
screen-edge Back gesture; hardware Back also closes an open sidebar. Native
conversation-row swipes retain T3's gesture handling and spring.

The composer uses T3's toolbar fade durations (160/120 ms), status transitions
(180/140 ms), and iOS-only 220 ms layout transition. Android has no competing
layout transition during keyboard resizing. Vivid does not include T3's
KeyboardStickyView dependency; Android sizing uses the existing native editor's
height events and KeyboardAvoidingView.

## Reconstructed Grok Bot audit

The reconstructed renderer was inspected at:
`/home/kixey/refs/grok-bot-0.39-reconstructed/recovered/frontend/dist/renderer/assets`.

The actual `Ole` semantic Sand table and `mf`/`T1`/`cd` primitive palettes in
`index-BOQal1n5.js` were extracted into `design-reference/grok-sand.ts`:
132 semantic entries per appearance, with source SHA-256 recorded in that file.
Light defaults were also compared with `index-9_2GMuRe.css`, and the bot-creation
and plugins screenshots were inspected.

This is an audit reference, not a second active theme. Vivid web already adapts
that family of layered surfaces and compact controls, with its own violet Face,
accent, typography and product hierarchy. The native app consumes Vivid's shared
CSS exports rather than replacing them with Grok's unmodified desktop palette.
Grok's reconstructed renderer is not a React Native library. Its desktop icon
font is not substituted for Vivid web's actual Lucide and custom SVG assets.

## Conversational connectors

The reconstructed Grok renderer registers
`features/chat/cards/send-message/connector/view.tsx` via
`chunk-view-WUVAt8pV.js`. It passes the conversation message's `connector`,
`reason`, `serverId`, `suggestions`, and `variant` into
`chunk-connector-card-Er2c5P-W.js`. That implementation resolves live status,
chooses install/authorize/manage, and starts authorization with trigger
`connector_card`. Its handoff includes reopen/retry actions; connected state
comes from the connector service.

Vivid adapts this behavior to its three existing services through the
`suggest_connector` tool and web/native `ConnectorRequestCard` components.
Cards use Vivid's actual ToolMarks and surface/control tokens. They fetch status,
open authorization on a user press, refresh on return, and offer Continue after
connection. The native button retains T3 menu/composer infrastructure and Vivid
press motion. Grok's desktop MCP installation and multiple-account catalog are
not implemented in Vivid's connector backend.

Today has no public navigation entry in either app. Connector management lives
in Settings; conversation cards are the contextual entry to authorization.
