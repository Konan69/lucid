# Library

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The real ingestion worker completes and the Person can open/download the original bytes and search extracted text. Remove the owned file afterward.

## How to get to it (user POV)

Open Library, upload an owned text/PDF file and search it.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature library` after Launch and Doctor. Inspect `library/verdict.json`, the action transcript, settlement, history and SQL. Then run `verify browser library`. A missing browser recipe exits unsuccessfully with `no browser recipe`; it cannot prove this feature. A blocked recipe exits unsuccessfully and names its missing prerequisite.

## Gotchas

Blocked until HTTP and browser ingestion recipes are implemented. The full product routes and extraction worker are mounted. A file row inserted directly is not an ingestion proof.
