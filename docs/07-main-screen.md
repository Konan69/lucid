# Main screen

2026-10-03: Historical first-screen proposal; later product direction is in [docs/22](22-one-product.md), and current implemented surfaces superseding this proposal’s status are recorded in [docs/14](14-product-feature-set-and-grok-bot-parity.md).

Status: first proposal, 2026-09-02. A hybrid of Open Session's layout, T3 Code's status-aware
sidebar, and Grok Bot's one-relationship simplicity. Everything else in the product accumulates in
[Surface](03-surface.md); this document is only the screen the user lives in.

## Layout

Two columns by default. A third opens on demand.

```
┌──────────────┬──────────────────────────────────────────┬──────────────┐
│  sidebar     │  thread                                   │  (panel)     │
│  260px       │  fluid                                    │  on demand   │
└──────────────┴──────────────────────────────────────────┴──────────────┘
```

Open Session's proportions. The sidebar collapses to a rail on narrow widths and disappears on
mobile, where the thread is the whole screen.

## Sidebar

Top to bottom.

1. **Vivid.** Face and the word Vivid, with no descriptive status line underneath it.
2. **Product entry points.** Today, Routines, and Library are the current exploration because they
   describe things a person wants to do. They replace infrastructure nouns such as Agents,
   Skills, Connectors, and Automations.
3. **New thread** and **search**, one row.
4. **Threads, grouped by state**, in this order, each group collapsible and hidden when empty:
   - **Needs you.** Threads where Vivid is waiting on an answer or an approval. A colored dot.
   - **Working.** Threads Vivid is currently acting in. A soft pulse.
   - **Recent.** Everything else, newest first, by day: Today, Yesterday, This week, Earlier.
   - **Pinned** sits above Recent if anything is pinned.
   - **Archived** at the bottom, collapsed.
5. **You.** Avatar and name, which opens the gear.

Infrastructure categories do not appear here. Team participation can appear naturally in thread
content and participants; its exact v1 presentation remains open.

### Thread row

Borrowed directly from T3 Code, stripped of the developer bits.

- **Title** Vivid wrote, one line, truncated.
- **Status label** in color, right-aligned, only when it is not "ready": Working, Needs you,
  Approve, Failed. Ready rows show nothing. This is a design proposal, not a user decision.
- **Unread** is a bold title, not a badge.
- **A tiny indicator** when Vivid is using its screen in that thread, so the user knows the panel
  has something to show. This replaces T3's terminal icon.
- **Hover actions.** Pin, archive, rename. Nothing else.

Status derivation and selected-row styling are design proposals. Vivid did not prescribe an active
state; do not attribute one to him without a direct decision.

## Thread

Open Session's thread, with Grok Bot's voice.

- **Header.** Title, editable inline. A share or "add someone" affordance at the right, which is how
  a colleague's Vivid or a colleague joins this thread later. That is the org mechanic's only
  fixed UI.
- **Messages.** User on the right, Vivid on the left with its face. Three kinds of Vivid message:
  plain text, a collapsible working block with a one-line summary and step count, and a card when
  Vivid needs input, with labeled options, a one-line tradeoff each, an "or type your own" field,
  and one Answer button.
- **Composer.** One box with attach, mic, send. While Vivid works it reads "Queue for when Vivid
  finishes". No model or mode picker.

## Panel, on demand

The third column exists so the sidebar never has to. It opens from a message, never from the
sidebar.

- **Vivid's screen.** A live work preview for this thread. It opens from the working block, or from
  "watch" in the header when the row indicator is on. Its transport and control implementation sit
  behind the private execution boundary.
- **A file or document.** Anything Vivid made or was given, opened inline from a chip in the
  thread.
- **The log.** "What Vivid did" for this thread, with the permissions it asked for and the answers.

Close it and the layout returns to two columns.

## Empty state

The sidebar shows only Vivid and You. The thread area is Vivid's greeting: the face, "Hi. What
should I take off your plate?", and three suggestion cards written as sentences. The composer has
focus. Typing anything creates the first thread and the first sidebar row.

## What is not on this screen

A home page. An inbox. A feed. A pull request list. A workspace picker. A bot roster. A model name.
A cost readout. A plugin button. If any of these seem necessary later, the answer is a thread row
with a status, or a panel opened from a message.
