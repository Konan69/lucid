# Send a picture

## Sub-features

History retains a file part; the authenticated attachment route returns the exact sent bytes, image media type and nosniff. Reload draws the image.

## How to get to it (user POV)

Attach a local PNG in a private Thread and send it.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature picture` after Launch and Doctor. Inspect `picture/verdict.json`, the action transcript, settlement, history and SQL. Then drive the visible controls with `verify browser` or the same owned browser session. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Shared Threads intentionally refuse pictures with Flue 2.2.2. The HTTP helper submits a tiny owned PNG. For attachment UI changes use the composer file input; an HTTP upload does not prove that control.
