# Feed

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The Person sees the delivered work and can open its Thread. Reload retains it and read/attention changes reach the same Feed.

## How to get to it (user POV)

Open Feed after a real Watch occurrence.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature feed` after Launch and Doctor. Inspect `feed/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser feed`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked without a real Watch occurrence. A synthetic Feed row does not prove delivery.
