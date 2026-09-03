# Design language

Why T3 Code and Open Session feel premium, read from their source, and the rules Konan keeps.

## Prominence comes from shape, not color

T3 renders a thread two ways. A **card** is 78px: a context line (project mark and name, then a
status slot), the title, and room for a third line. A **slim** row is 36px: the title and a time.
Which one a thread gets is decided by its lifecycle, not by styling. Active and pinned threads are
cards. Settled ones are slim. The eye sorts the list before reading a word.

Open Session runs the rail on three heights and nothing else. 36px for a line that navigates or a
heading that leads with a mark. 32px for the tool rows at the top. 28px for a caption with no
mark: Needs action, Recent, Yesterday, Pinned. Hierarchy comes from type, mark, and the hover pill.
Height stays regular.

**Konan:** card rows for Needs you, Working, and Pinned. Slim rows for the rest. Captions at 28px.

## Rows recede unless a human is needed

T3's rule, in its own comment: in-flight rows fade as a whole because there is nothing for the
user to do yet. Prominence is reserved for rows that need a human: an unread completion, a
failure, a thread that just woke. The status label keeps its hue so a waiting row stays
findable. Read-and-ready rows recede the same way. The list is inbox zero by default.

**Konan:** the same derivation. Status is computed from the run and the last message, never set.
Unread is a bold title. Everything else is quiet.

## The status slot yields, nothing shifts

The right end of a T3 row is one slot of fixed minimum width. At rest it shows the status and a
ticking duration in tabular mono. On hover or keyboard focus it shows the actions instead. The
hidden state is out of flow, so the title reclaims the space and the row never jumps.

**Konan:** same slot. Pin, snooze, archive on hover. Status and time at rest.

## Only lines that navigate get a hover fill

Open Session paints a hover pill on rows and tool rows and Archived, because clicking them takes
you somewhere. A heading that merely collapses a group brightens its ink and nothing more. A rail
where every line lights up teaches that the pill means nothing.

**Konan:** captions and shelf toggles brighten. Rows fill.

## Lifecycle shelves, not folders

T3: Pinned, then Active, then a Snoozed shelf with a wake countdown and an amber Woke pill until
you visit, then a Settled shelf, collapsed, with "Show 10 more". Settling is how a thread leaves
your attention without being deleted. Un-settling returns it to the top with its timestamps intact.

**Konan:** Needs you, Working, Pinned, then days, then Snoozed and Done shelves. Done is T3's
Settled. Archive is the only destructive-feeling action and it is one level below.

## One box-shadow does elevation and edge

Open Session stacks two cast layers and a hairline ring in one box-shadow, in tiers: xs for a
control resting in the page, sm for a compact floating control, md for menus, lg for dialogs and
big cards, soft for large cards over content. The ring fades as elevation rises, so a menu keeps
a little definition and a dialog lets its shadow define the edge. Never add a border to an element
that already carries a ring.

In dark, a cast shadow has nothing to fall on, so a lifted plate carries a specular top edge
instead: one inset hairline of light. That is what says "raised" on a near-black page.

**Konan:** shadow tiers xs, sm, md, lg, soft, each with a ring variant. Edge highlight in dark.

## Type has weight

Open Session sets body weight to 500 and does not antialias, so text in the web UI matches the
native app beside it instead of reading a stem thinner. Metadata and supporting copy drop to 400
so they stay quiet. Sizes are hand-picked pixels, scaled up on phone. Durations are tabular mono.

**Konan:** 500 body, 400 meta, no antialiasing, px scale, mono tabular for anything that ticks.

## Status hues are a convention, not decoration

T3 uses the same three hues everywhere a thread surfaces, in the sidebar, on mobile, in widgets:
amber for approval, indigo for input, sky for working. Red for failed. A thread reads the same
color in every place.

**Konan:** amber for Approve, accent for Needs you, sky for Working, green for Done, red for
Failed. Nowhere else uses those hues.

## The composer is the roundest thing on the page

Open Session makes the composer the one surface with the largest radius, because it is the one
thing you touch. Surfaces physically attached to it, the queue flap and the agents flap, read the
same radius token so the seam stays flush.

**Konan:** composer radius is its own token. The queued-message flap attaches above it and shares it.

## Glass is for what floats over live content

Tooltips, hover cards, and menus take a thinned fill over a heavy blur so what shows through is
color and shape, never someone else's sentence. Opaque fallback when backdrop-filter is missing.

**Konan:** glass utility for tooltips and popups only. Panels and sidebars are opaque.
