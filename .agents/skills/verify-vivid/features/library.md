# Library

## Sub-features

The real ingestion worker completes and the Person can open/download the original bytes and search extracted text. Remove the owned file afterward.

## How to get to it (user POV)

Open Library, upload an owned text/PDF file and search it.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature library` after Launch and Doctor. Inspect `library/verdict.json`, the action transcript, settlement, history and SQL. Then drive the visible controls with `verify browser` or the same owned browser session. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked here because this composition does not mount the Library routes and extraction workers. A file row inserted directly is not an ingestion proof.
