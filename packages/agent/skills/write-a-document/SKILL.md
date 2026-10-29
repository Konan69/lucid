---
name: write-a-document
description: |-
  When the Person wants a report, plan, proposal, notes, long draft, Word document or PDF they will keep or edit.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/artifacts/document/SKILL.md`.
    Markdown read-back verifies text records. Computer files use captured render inspection
    before publication, retaining exact output and editable source bytes in the Thread.
---

Settle what the document is for, who reads it and what it must contain before writing. Use `search_library` for supplied material and ask with `ask_person` only when a missing fact changes the content. Content comes from what was gathered or supplied; a value you do not have is a stated gap or a question, never an invented figure.

For a Markdown document, write it with `write_document` under a clear, human-readable title that says what it is; the title is how the Person and later turns find it. Give it real structure: headings for the sections a reader navigates by, real numbered or bulleted lists rather than typed symbols, a table only for things compared on the same attributes, and separate paragraphs rather than line breaks inside one. Follow the outline, headings and wording the Person specified literally.

The saved Markdown document is the editable source for every later revision. To change it, read the current version with `read_document`, then write the whole revised body under the same title with one sentence about what changed. Never rewrite from memory of an earlier draft, and never start a second title for the same document. If the title is missing, choose from the titles returned rather than guessing.

Before handing it over, read it back with `read_document` and check what the Person will actually see: every section present and in order, no heading without a body, no cut-off sentence, no leftover placeholder, note to self or sample text. Fix what you find and read again. Say the document is ready only after a clean read-back, and report its title and what it covers. Sending or sharing it outside the Thread needs its own Approval.

For a Word or PDF deliverable, create the real file on the Computer. Keep the DOCX as editable source. Use `inspect_file` with the DOCX and source kind `output`, or with an exported PDF and source kind `separate` naming the DOCX. Inspection captures exact bytes and returns a PNG of their first page. Look at that image for clipping, missing text, unreadable type and broken layout. Check later pages on the Computer for a multi-page file. Fix defects in the source, export again if needed, and inspect the corrected output again.

Only after reviewing the captured image, call `publish_file` with its inspection reference, a clear title and a short account of what you checked visually. The saved version uses the captured output, source and preview. Later changes on the Computer do not change it. Reuse the title for the next version. A render failure or missing source blocks delivery. Report that failure plainly and fix it before publishing. Say a file is delivered only when publication succeeds.
