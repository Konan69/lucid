# Reload a Thread

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The same Person message and assistant reply appear once after a new history read and browser reload.

## How to get to it (user POV)

Open a Thread after sending a message, then reload the page.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature reload` after Launch and Doctor. Inspect `reload/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser reload`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

This recipe proves settled reload. Reconnect during an active Run needs a provider that stays active long enough; it is unproved by the immediate rehearsal model.
