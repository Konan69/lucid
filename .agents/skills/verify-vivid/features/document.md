# Documents

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

One Rehearsal plan Artifact advances from version 1 to 2 under the same id. The real read tool reports version 2. Person ListArtifacts and SQL retain the immutable versions. Reload retains the rendered Wrote a document tool card. The web currently has no Artifact opener; opening/editing the body is blocked. HTTP versioning alone never proves an editor.

## How to get to it (user POV)

Send write a document, then revise the document, then read the document.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature document` after Launch and Doctor. Inspect `document/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser document`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

The document is real SQL data written by the runtime tools. Person edits and version conflict handling are separate entry points; open the Artifact and edit it when those paths change.
