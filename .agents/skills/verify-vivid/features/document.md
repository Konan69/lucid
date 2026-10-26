# Documents

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

One titled Artifact advances from version 1 to 2 under the same id. The third Run must contain a successful read_document tool part reporting version 2 and the added sentence Ready for review. The public version 2 body must also contain that sentence. Person ListArtifacts reports the latest summary; GetArtifact reads each immutable version, with SQL retaining the stored versions. Since 26 October 2026 the Thread draws no step rows: the browser proves the reply arrived as Vivid's bubbles and that no step list, "more steps" or "Worked" line is drawn, before and after reload. The web currently has no Artifact opener; opening/editing the body is blocked. HTTP versioning alone never proves an editor.

## How to get to it (user POV)

Send write a document, then revise the document, then read the document.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature document` after Launch and Doctor. Inspect `document/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser document`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

The document is real SQL data written by the runtime tools. Person edits and version conflict handling are separate RPC entry points. Opening the body in the web is blocked until the product has an Artifact viewer and this skill has its browser recipe.
