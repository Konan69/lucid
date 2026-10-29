# Waiting on

Model requirement: needs a real model. Rehearsal cannot prove it.

## Sub-features

Vivid keeps the list of who owes the Person what (`Owed`, `packages/contracts/src/owed.ts`) and chases it. A record starts Open, becomes Nudged once Vivid chased it, and closes as Resolved or Dropped. The Feed lists only open and nudged records, soonest due first, under "Waiting on", above the cards that need the Person. Each row says who owes what, when it is due or how long the Person has waited, a time track, and what Vivid knows or does next. A row opens its Thread. Its check (web hover, focus or touch; phone hold menu) resolves it; the menu also stops waiting on it. A closed row folds away at once and leaves the list for good.

## How to get to it (user POV)

In any Thread, tell Vivid that someone promised you something: "Tunde promised to send me the Q4 deck with the new numbers by Friday. Can you keep an eye on that for me?" Open Feed. The row is under "Waiting on". Press its check, or hold it on the phone and choose Received.

## Driving it with verify-vivid

After Launch and Doctor, run `verify feature owed <run>` and `verify browser owed <run>` on the unchanged commit, then `verify cleanup <run>`.

The HTTP recipe ([owed.mjs](../scripts/owed.mjs)) sends the sentence above through the public Thread transport, waits for WatchThread settlement, requires exactly one successful `track_owed` call in that Run, and reads `ListOwed` for exactly one record from Tunde about the deck, naming that Thread. It resolves the record with `ResolveOwed`, the call the Feed row makes, and reads it back as Resolved.

The browser recipe ([owedbrowser.mjs](../scripts/owedbrowser.mjs)) types the same sentence into the composer and presses Send, then opens `/feed`, waits for "Waiting on" and the row, captures `feed.png`, presses the row's "Received from Tunde" button, waits for the row to fold, reloads, checks the row is absent, and reads the record as Resolved.

## Evidence

HTTP under `owed/`: `track-calls.json`, `listed.json`, `resolved.json`, `scope.json`. Browser under `browser/owed/`: `thread.png`, `feed.png`, `received.png`, `reloaded.png` and their snapshots.

## Gotchas

Chasing over time (Vivid sending a nudge and the row showing it) is not driven: it needs a check-in to come round. Stop waiting through the menu, and the phone's hold menu, are not driven by these recipes; the phone needs its own emulator run. The model may ask a follow-up question instead of tracking at once; the journey then fails on the missing `track_owed` call, which is a real behaviour finding, not a flake.
