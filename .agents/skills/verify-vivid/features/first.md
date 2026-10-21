# First message

## Sub-features

A real Person contribution and streamed rehearsal reply persist through Flue history. GetThread reports a Completed Run.

## How to get to it (user POV)

Sign in and press New thread. Send Hello Vivid.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature first` after Launch and Doctor. Inspect `first/verdict.json`, the action transcript, settlement, history and SQL. Then drive the visible controls with `verify browser` or the same owned browser session. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Private Threads and an email account created through Better Auth are the default. The first-arrival greeting is a separate entry point; use OpenFirstThread and verify its once-only receipt when changing arrival behavior.
