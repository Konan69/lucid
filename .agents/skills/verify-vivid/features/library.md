# Library

Model requirement: needs a real model. Rehearsal proves plumbing only.

## Sub-features

The Person uploads an owned text file. The real ingestion worker indexes it, search finds its text, and Vivid retrieves and cites its answer in a Thread. The file and cited reply survive reload. The browser also opens the original bytes in another tab. Each recipe removes its own file in finally.

## How to get to it (user POV)

Open Library, upload an owned text/PDF file and search it.

## Driving it with verify-vivid

Run `.agents/skills/verify-vivid/verify feature library` after Launch and Doctor, then run `verify browser library`. Inspect `library/verdict.json` and `browser/library/verdict.json`. Each retains the uploaded fixture, WatchLibrary ingestion publications, public search and original-byte receipts, model search_library output, citation, settlement and reloaded history. The browser retains its commands, snapshots and screenshots before upload, at readiness, in the original tab, after search and after reload.

## Gotchas

WatchLibrary's ready publication is the ingestion signal. No sleeps or inserted rows substitute for the worker. The randomized answer appears only in the uploaded file, never in the question. The proof requires the real search_library output and a source citation in the reply. PDF extraction, Company shelves, folders, rename/move, duplicate feedback and Ask Vivid remain outside this recipe.
