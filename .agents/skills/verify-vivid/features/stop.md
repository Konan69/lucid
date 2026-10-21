# Stop work

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The captured active Run becomes Stopped. Streaming ends, Stop disappears and reload retains the interrupted reply without restarting it.

## How to get to it (user POV)

Send a request that is visibly still working. Press Stop.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature stop` after Launch and Doctor. Inspect `stop/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser stop`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked with the immediate rehearsal model. Do not claim a stop proved after a Run already completed. No timing seam or held handler is installed.
