# Send a picture

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

History retains a file part; the authenticated attachment route returns the exact sent bytes, image media type and nosniff. Reload draws the image.

## How to get to it (user POV)

Attach a local PNG in a private Thread and send it.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature picture` after Launch and Doctor. Inspect `picture/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser picture`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Shared Threads intentionally refuse pictures. The HTTP helper submits a tiny owned PNG. For attachment UI changes use the composer file input; an HTTP upload does not prove that control.
