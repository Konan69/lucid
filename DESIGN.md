# Vivid — Design language

What any agent (human or AI) must follow to touch Vivid's UI. Ground truth:
`packages/design/tokens/src/tokens.css` is the single source for every value
in this file. If code and this file disagree, fix one of them — never fork.

## The one product rule

Every screen must justify why it is not a message in the thread. One surface:
a thread list, a thread, a settings gear. Vivid is the agent — the word
"agent" never appears in the product. See `docs/01-principle.md`.

## Sources, and what each settled

| Source          | What Vivid took                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- |
| Open Session    | Surface ramp, shadow tiers, edge shadow rule, type weights, composer radius, rail heights |
| Grok Bot (Sand) | Alpha ink from one base, status hue pairs, the ten face colors, and theme tokens          |
| T3 Code         | Card vs slim rows by lifecycle, rows recede, status yields to actions in one slot         |

## Tokens — the only allowed colors

Every color a component uses is a semantic token from `tokens.css`. **Never a
raw hex, never a new one-off value.** If a design needs a color the tokens
don't have, the tokens change first, then the component.

- **Surfaces step one direction.** `surface-0` (page) → `surface-1` (chrome) →
  `surface-2` (cards/rows) → `surface-3` (controls), lighter in dark, darker in
  light. A token never swaps tier between themes — the same stack must read
  raised in both.
- **Ink is alpha.** `ink`/`ink-2`/`ink-3`/`ink-4` are one base color at
  falling alpha. Text, icons, and borders all derive from it. No grays. Words
  that must be read stop at `ink-3`; `ink-4` is for marks and placeholders.
- **Hairlines are alpha ink** at 6–30%. Lines separate structure; shadows
  create depth. Never both on one element.
- **Accent is Vivid's color** (`#7c6cff`). It appears on the face, the focus
  ring, the one primary button, and "Needs you". Nowhere else.
- **Status hues are a convention**: sky = working, accent = needs you,
  amber = approve, green = success, red = danger. A thread reads the same hue
  in the sidebar, the thread, and the header. Nothing decorative uses them.
- **Faces are the ten Grok Bot colors.** Vivid's face is always violet.

## Elevation

Elevation is `shadow-plugin`'s `smooth-shadow-ring-*`: one `box-shadow` whose last layer is the
hairline, coloured by `--smooth-ring-color` in the tokens. There are two tiers and nothing between.

- **In the page** (cards, rows, fields, the sidebar's cards): `smooth-shadow-ring-xs`. A hairline
  and the faintest ambient. Nothing is cast: a card in a list is not floating and must not look it.
- **Over the page** (the composer, menus, dialogs, the palette): `smooth-shadow-ring-md` or `-lg`.

Never add a border or ring to an element that already carries a shadow tier, never write a
`box-shadow` by hand, and never raise a card's tier on hover: hover is a fill. The sidebar and the
content column are separated by one hairline, not by a shadow.

Glass (`backdrop-filter`) is for what floats over live content: tooltips,
popups. Panels and sidebars are opaque.

## Layout

- Sidebar 268px. Row heights are a fixed scale: **36** a line that navigates,
  **32** tool rows, **28** a caption (no mark, no fill), **78** a card.
- Prominence comes from **shape, not color**: active/pinned/needs-you threads
  are cards; everything else is slim; captions are 28px. The eye sorts the
  list before reading a word.
- **Rows recede unless a human is needed.** In-flight and read rows fade as a
  whole; the status label keeps its hue. Unread is a bold title, nothing more.
- **The status slot yields.** One fixed-width slot at the row's right end:
  status at rest, actions on hover, same width, nothing shifts.
- **Only lines that navigate get a hover fill.** Captions brighten their ink.
  A rail where everything lights up teaches that the fill means nothing.
- Thread max width 760px. **The composer is the roundest thing on the page**
  (`--radius-composer`); the queue flap attaches flush above it.

## Type

Body 500, meta 400, no antialiasing — web text must match the native app
beside it. Sizes are hand-picked px (11–28), scaled up on phone (`--rf`).
Anything that ticks (durations, countdowns) is mono tabular.

## Motion

- Durations: fast 120ms, base 200ms, slow 320ms. UI stays under 300ms.
- Enters use `--ease-out`; nothing on screen ever uses `ease-in`.
- Press feedback: `scale(0.96)` on active, 120ms, transform+background only.
- Enter from `scale(0.95)` + opacity 0, never `scale(0)`.
- Reduced motion: keep opacity/color, drop movement.
- High-frequency interactions get instant feedback or ≤150ms opacity/color.
  Motion is never the only feedback channel — every state also has a static cue.
- A page change moves. When an item takes the Person to another page (a Feed
  card opening its chat), the item and the page move as one transition: the
  new page comes in while the item travels into its place there, and both
  settle together. A cross-fade alone is not a page transition, and nothing
  snaps when it lands. The owner, 11 November 2026: "page changing should have
  animations"; "there is no cohesion between the animations ... one item is
  dropped from one page to another". Screens use the platform's own slide
  (`apps/mobile/src/ui/stack.ts`).
- The app's current motion is not the reference for how motion should feel.
  Before copying it, read the named reference (`animation-vocabulary`,
  `apple-design`, the platform's own transition) and say what you read. The
  owner, 11 November 2026: "the apps own could be wrong do research".

## Copy

- Labels say what a thing is or does, in plain words. No chatty or
  personified lines about Vivid or the Person: "4 to decide.", "The rest is
  handled.", "Busy with these" and a "Move it" message were all rejected. The
  owner, 11 November 2026: "stop trying to be punchy follow the vibe"; "stop
  this cringe humanizing copy".
- A finished state is a mark where a mark reads: a tick or a dot, not "Done"
  or "Handled". The owner, 11 November 2026: "tick emoji or dot on the right
  is better than done".
- `better-writing` reviews every string against this section.

## Product rules the UI enforces

- Capabilities arrive on demand, as a question in the thread — never as a
  settings page.
- Automations are said, not built: a sentence, confirmed as a card.
- Status is computed from the run, never set by hand.
- Change the surface, not the substrate.
- A Feed card holds more than text through the displays a reply uses: line
  items, a route, a meter or a file are an OpenUI display drawn by Vivid
  (`packages/agent/runtime/src/agents/displays.ts`, the `Drawn` card in
  `apps/web/src/screen/feed/Card.tsx`), never a component built for one card
  kind. The owner, 11 November 2026: "the cards should be able to hold more
  than just text ... we have openui for a reason".

## Where things live

| Thing                               | Path                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| Tokens (single source of truth)     | `packages/design/tokens/src/tokens.css`              |
| Shadow + glass + hairline utilities | `apps/web/src/styles/index.css`                      |
| Design-language essays              | `docs/08-design-language.md`, `docs/01-principle.md` |
| Token sheet (every token, one page) | run dev server, open `/?tokens`                      |
