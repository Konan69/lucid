# Feed

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The Person sees the delivered work and can open its Thread. Reload retains eligible items and read/attention changes reach the same Feed. Waiting and Working items remain visible; Handled history is limited to 100 items from the last 24 hours.

## How to get to it (user POV)

Open Feed after a real Watch occurrence.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature feed` after Launch and Doctor, then run `verify browser feed`. Both commands currently return blocked before exercising the journey. Inspect `feed/verdict.json` and `browser/feed/verdict.json`; no action transcript, settlement, history or SQL is produced. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Both recipes are blocked. Full proof needs an implemented journey and a real Watch occurrence through disposable Executor authority and a public callback. Inline actions, Done, retry, automatic seen state and display Query/Mutation execution remain unproved; see apps/web/src/screen/feed/Card.tsx. A synthetic Feed row does not prove delivery.
