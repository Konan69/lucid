# Reload a Thread

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

A settled Thread exists before the client opens it. Reopening and reloading preserve its first turn. A contextual follow-up recalls amber-orchid, creates exactly one second turn, and both turns survive another reload. The browser counts settled assistant messages whose rendered text exactly equals amber-orchid after whitespace and trailing punctuation are normalised. The count must be zero before the follow-up and one after it and after reload. before-reply.json records the live count before the follow-up is sent.

## How to get to it (user POV)

Open an existing Thread, reload, then ask a follow-up about its earlier message.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature reload` after Launch and Doctor. Inspect `reload/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser reload`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

This recipe proves reopening an existing settled Thread and continuing its context. Mid-stream reconnect remains unproved. The first feature starts from an empty Thread; reload starts with durable history.
