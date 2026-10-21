# Watches

## Sub-features

A durable Watch receives an actual event, creates a bounded background Run and appears in Feed. Record provider receipt, Watch and Run ids.

## How to get to it (user POV)

Connect a disposable Integration. Ask Vivid to follow an event, then produce a real provider event.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature watch` after Launch and Doctor. Inspect `watch/verdict.json`, the action transcript, settlement, history and SQL. Then drive the visible controls with `verify browser` or the same owned browser session. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Routines were removed from main. Watch workers are not mounted in this isolated composition; this recipe is blocked until a disposable Integration and full worker graph are available. Never recreate the removed Routine fixture.
