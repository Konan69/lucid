# Documents

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

One titled Artifact advances from version 1 under the same id. Vivid may revise more than once in the revision Run; every new version must be one of that Run's successful write_document receipts. The third Run must contain a successful read_document tool part reporting the latest version and the added sentence Ready for review. The public latest-version body must also contain that sentence and differ from version 1. Person ListArtifacts reports the latest summary; GetArtifact reads each immutable version, with SQL retaining the stored versions. Since 26 October 2026 the Thread draws no step rows: the browser proves the reply arrived as Vivid's bubbles and that no step list, "more steps" or "Worked" line is drawn, before and after reload. The web Thread draws each delivered Artifact as a card whose Open button shows the viewer with versions, Download, Edit and Delete (`apps/web/src/screen/artifact/Card.tsx`, `Viewer.tsx`); this recipe does not drive the viewer. HTTP versioning alone never proves an editor.

## How to get to it (user POV)

Send write a document, then revise the document, then read the document.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature document` after Launch and Doctor. Inspect `document/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser document`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

The document is real SQL data written by the runtime tools. Person edits and version conflict handling are separate RPC entry points. The [files recipe](files.md) opens the viewer for a workbook; no recipe opens or edits a Markdown document in it.

## File delivery

The real-model HTTP recipe also creates a one-page Word document on the Computer, exports a PDF, calls inspect_file and checks that its projected tool result contains native image content before publish_file. GetArtifact must retain the PDF output, separate DOCX source, PNG preview and matching render-review digest. Authenticated downloads of every role must match the stored SHA-256 and length. The recipe saves file-artifact.json, file-proof.json and each downloaded file beside the conversation evidence. Markdown tool receipts now carry ArtifactMessage references in client state, while model text retains its title and version.

This step needs `VIVID_BOAT_API_KEY` in `VIVID_VERIFY_KEY_FILE`, which gives Launch a disposable Computer; without it `verify feature document` fails at the file step. Never use the production Computer. The PostgreSQL/SSH integration test separately proves publication retries, source mutation isolation and byte-route access/digests. It does not prove LibreOffice rendering or the model's visual review.

## Workbook publication

Run `verify feature files <run>` and `verify browser files <run>` for the XLSX file-publication recipe in [files.md](files.md). It proves cell read-back, exact captured downloads, editable output and an immutable revision separately from Markdown document behavior.
