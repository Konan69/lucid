# Stop work

## Sub-features

The captured active Run becomes Stopped. Streaming ends, Stop disappears and reload retains the interrupted reply without restarting it.

## How to get to it (user POV)

Send a request that is visibly still working. Press Stop.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature stop` after Launch and Doctor. Inspect `stop/verdict.json`, the action transcript, settlement, history and SQL. Then drive the visible controls with `verify browser` or the same owned browser session. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked with the immediate rehearsal model. Do not claim a stop proved after a Run already completed. No timing seam or held handler is installed.
