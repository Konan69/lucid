# Watches

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

A durable Watch receives an actual event, creates a bounded background Run and appears in Feed. Record provider receipt, Watch and Run ids.

## How to get to it (user POV)

Connect a disposable Integration. Ask Vivid to follow an event, then produce a real provider event.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature watch` after Launch and Doctor, then run `verify browser watch`. Both commands currently return blocked before exercising the journey. Inspect `watch/verdict.json` and `browser/watch/verdict.json`; no action transcript, settlement, history or SQL is produced. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Routines were removed from main. The real Watch workers are mounted. Both recipes are blocked. Full proof needs an implemented journey, disposable Executor authority, a connected Integration with observable incoming events and a publicly reachable callback. This launch points Executor at refused loopback port 1. Conversational list/stop and made-Integration reminders remain unproved; see packages/agent/runtime/src/tools/watches.ts and apps/server/src/watches/reminder.live.test.ts. Never recreate the removed Routine fixture.
