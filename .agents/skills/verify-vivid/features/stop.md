# Stop work

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The captured active Run becomes Stopped. Streaming ends, Stop disappears and reload retains the interrupted reply without restarting it.

## How to get to it (user POV)

Send a request that is visibly still working. With an empty draft, press Stop in the composer. An open question has a separate Stop control, including while typing or uploading a picture.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature stop` after Launch and Doctor, then run `verify browser stop`. Both commands currently return blocked before exercising the journey. Inspect `stop/verdict.json` and `browser/stop/verdict.json`; no action transcript, settlement, history or SQL is produced. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked until a reproducible active Run recipe exists for the selected real model. Do not claim a stop proved after a Run already completed. No timing seam or held handler is installed.
