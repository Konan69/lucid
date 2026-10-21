# Documents

## Sub-features

One Rehearsal plan Artifact advances from version 1 to 2 under the same id. The real read tool reports version 2. Person ListArtifacts and SQL retain the immutable versions. Reload still shows the document.

## How to get to it (user POV)

Send write a document, then revise the document, then read the document.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature document` after Launch and Doctor. Inspect `document/verdict.json`, the action transcript, settlement, history and SQL. Then drive the visible controls with `verify browser` or the same owned browser session. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

The document is real SQL data written by the runtime tools. Person edits and version conflict handling are separate entry points; open the Artifact and edit it when those paths change.
